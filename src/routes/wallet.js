import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getApiKey } from '../services/apiKeys.js';

const router = Router();
const prisma = new PrismaClient();

async function getWallet() {
  return prisma.wallet.upsert({
    where: { id: 'global' },
    create: { id: 'global', balance: 0 },
    update: {},
  });
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const wallet = await getWallet();
    const transactions = await prisma.walletTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ balance: wallet.balance, transactions });
  } catch (e) { next(e); }
});

router.post('/topup/initiate', requireAdmin, async (req, res, next) => {
  try {
    const { amountRm } = req.body;
    const amount = parseFloat(amountRm);
    if (!amount || amount < 1) return res.status(400).json({ error: 'Minimum top-up is RM 1' });

    const apiKey = await getApiKey('billplz_api_key');
    const collectionId = await getApiKey('billplz_collection_id');
    if (!apiKey || !collectionId) {
      return res.status(400).json({ error: 'Billplz API key and Collection ID not configured in Settings → API Keys' });
    }

    const amountSen = Math.round(amount * 100);
    const tx = await prisma.walletTransaction.create({
      data: { type: 'topup', amountSen, note: `Top-up RM ${amount.toFixed(2)}`, status: 'pending' },
    });

    const callbackUrl = `${process.env.APP_URL}/wallet/webhook`;
    const redirectUrl = `${process.env.FRONTEND_URL}/settings?tab=wallet&topup=done`;

    const body = new URLSearchParams({
      collection_id: collectionId,
      email: req.user.email,
      name: req.user.name || 'Admin',
      amount: String(amountSen),
      description: `Wallet top-up RM ${amount.toFixed(2)}`,
      callback_url: callbackUrl,
      redirect_url: redirectUrl,
      reference_1_label: 'txId',
      reference_1: String(tx.id),
    });

    const billplzRes = await fetch('https://www.billplz.com/api/v3/bills', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const bill = await billplzRes.json();
    if (!billplzRes.ok) {
      await prisma.walletTransaction.update({ where: { id: tx.id }, data: { status: 'failed' } });
      return res.status(400).json({ error: bill.error?.message || 'Billplz error' });
    }

    await prisma.walletTransaction.update({
      where: { id: tx.id },
      data: { billplzId: bill.id },
    });

    res.json({ url: bill.url });
  } catch (e) { next(e); }
});

router.post('/webhook', async (req, res, next) => {
  try {
    const data = req.body;
    const billplzId = data['billplz[id]'];
    const paid = data['billplz[paid]'] === 'true';
    const xSig = data['billplz[x_signature]'];

    const apiKey = await getApiKey('billplz_api_key');
    const xSigKey = await getApiKey('billplz_x_signature_key');

    if (xSigKey && xSig) {
      const sigFields = Object.keys(data)
        .filter(k => k !== 'billplz[x_signature]')
        .sort()
        .map(k => `${k}${data[k]}`)
        .join('|');
      const expected = crypto.createHmac('sha256', xSigKey).update(sigFields).digest('hex');
      if (expected !== xSig) {
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    if (!paid) return res.json({ ok: true });

    const tx = await prisma.walletTransaction.findUnique({ where: { billplzId } });
    if (!tx || tx.status === 'paid') return res.json({ ok: true });

    await prisma.$transaction([
      prisma.walletTransaction.update({ where: { billplzId }, data: { status: 'paid' } }),
      prisma.wallet.upsert({
        where: { id: 'global' },
        create: { id: 'global', balance: tx.amountSen },
        update: { balance: { increment: tx.amountSen } },
      }),
    ]);

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Meta Malaysia business-initiated conversation rate (USD)
const META_MY_RATE = 0.0450;
// SendGrid estimated per-email cost on paid plan
const SG_PER_EMAIL = 0.0004;
// Outscraper per record already logged via costLogger

router.get('/spend-summary', requireAuth, async (req, res, next) => {
  try {
    const now = new Date();
    const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);

    const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const rate = settings?.usdRmRate || 4.70;

    // Claude — exact from ApiUsageLog (real token costs)
    const claudeLog = await prisma.apiUsageLog.aggregate({
      where: { service: 'claude', createdAt: { gte: start, lt: end } },
      _sum: { costUsd: true, units: true },
      _count: { id: true },
    });

    // Outscraper — exact from ApiUsageLog (records × $0.001)
    const scraperLog = await prisma.apiUsageLog.aggregate({
      where: { service: 'outscraper', createdAt: { gte: start, lt: end } },
      _sum: { costUsd: true, units: true },
    });

    // Email + WA counts from CampaignAction
    const [emailCount, waCount, enrichedCount] = await Promise.all([
      prisma.campaignAction.count({ where: { type: 'email', status: 'sent', sentAt: { gte: start, lt: end } } }),
      prisma.campaignAction.count({ where: { type: 'wa',    status: 'sent', sentAt: { gte: start, lt: end } } }),
      prisma.lead.count({ where: { enriched: true, enrichedAt: { gte: start, lt: end } } }),
    ]);

    // Vapi — fetch real call costs from their API
    let vapiCostUsd = 0;
    let vapiCount = 0;
    let vapiSource = 'none';
    try {
      const { getApiKey } = await import('../services/apiKeys.js');
      const vapiKey = await getApiKey('vapi');
      if (vapiKey) {
        const r = await fetch(`https://api.vapi.ai/call?startedAtGt=${start.toISOString()}&startedAtLt=${end.toISOString()}&limit=1000`, {
          headers: { Authorization: `Bearer ${vapiKey}` },
        });
        if (r.ok) {
          const data = await r.json();
          const calls = Array.isArray(data) ? data : (data.results || []);
          vapiCount = calls.length;
          vapiCostUsd = calls.reduce((s, c) => s + (parseFloat(c.cost) || 0), 0);
          vapiSource = 'live';
        }
      }
    } catch { /* Vapi optional */ }

    const breakdown = {
      claude:  { count: claudeLog._count.id || 0, costUsd: claudeLog._sum.costUsd || 0, costRm: (claudeLog._sum.costUsd || 0) * rate, tokens: Math.round(claudeLog._sum.units || 0), source: 'exact' },
      email:   { count: emailCount, costUsd: emailCount * SG_PER_EMAIL, costRm: emailCount * SG_PER_EMAIL * rate, source: 'calculated' },
      wa:      { count: waCount, costUsd: waCount * META_MY_RATE, costRm: waCount * META_MY_RATE * rate, source: 'calculated' },
      call:    { count: vapiCount, costUsd: vapiCostUsd, costRm: vapiCostUsd * rate, source: vapiSource },
      enrich:  { count: enrichedCount, costUsd: 0, costRm: 0, source: 'subscription', note: 'Apollo Professional — flat RM 465/mo' },
      scraper: { count: Math.round(scraperLog._sum.units || 0), costUsd: scraperLog._sum.costUsd || 0, costRm: (scraperLog._sum.costUsd || 0) * rate, source: 'exact' },
    };

    const total = parseFloat(
      Object.values(breakdown).reduce((s, v) => s + (v.costRm || 0), 0).toFixed(2)
    );

    res.json({
      month,
      total,
      budget: settings?.monthlyBudget || 1000,
      usdRmRate: rate,
      breakdown,
      refreshedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

router.patch('/budget', requireAuth, async (req, res, next) => {
  try {
    const { budget, usdRmRate } = req.body;
    const data = {};
    if (budget !== undefined) data.monthlyBudget = parseFloat(budget);
    if (usdRmRate !== undefined) data.usdRmRate = parseFloat(usdRmRate);
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', ...data },
      update: data,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/webhook/redirect', async (req, res, next) => {
  try {
    const { billplz } = req.body;
    if (!billplz) return res.json({ ok: true });
    const paid = billplz.paid === 'true';
    const billplzId = billplz.id;

    if (!paid) return res.json({ ok: false, paid: false });

    const tx = await prisma.walletTransaction.findUnique({ where: { billplzId } });
    res.json({ ok: true, paid: tx?.status === 'paid' });
  } catch (e) { next(e); }
});

export default router;
