import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getApiKey } from '../services/apiKeys.js';

const router = Router();
const prisma = new PrismaClient();

// In-memory FX cache — survives per-process lifetime, DB persists across restarts
let _fxCache = { rate: null, fetchedAt: null };
const FX_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

async function getLiveUsdRmRate() {
  if (_fxCache.rate && _fxCache.fetchedAt && Date.now() - _fxCache.fetchedAt < FX_TTL_MS) {
    return { rate: _fxCache.rate, source: 'cache', updatedAt: new Date(_fxCache.fetchedAt).toISOString() };
  }
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=MYR');
    if (!r.ok) throw new Error('API error');
    const data = await r.json();
    const rate = data.rates?.MYR;
    if (!rate) throw new Error('No MYR rate');
    _fxCache = { rate, fetchedAt: Date.now() };
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', usdRmRate: rate },
      update: { usdRmRate: rate },
    }).catch(() => {});
    return { rate, source: 'live', updatedAt: new Date().toISOString() };
  } catch {
    // Fall back to DB value or hardcoded default
    const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } }).catch(() => null);
    const fallback = settings?.usdRmRate || 4.70;
    _fxCache = { rate: fallback, fetchedAt: Date.now() };
    return { rate: fallback, source: 'fallback', updatedAt: new Date().toISOString() };
  }
}

async function getWallet(tid) {
  const existing = await prisma.wallet.findFirst({ where: { tenantId: tid } });
  if (existing) return existing;
  return prisma.wallet.upsert({
    where: { id: 'global' },
    create: { id: tid, tenantId: tid, balance: 0 },
    update: {},
  });
}

router.get('/fx-rate', requireAuth, async (req, res, next) => {
  try {
    const result = await getLiveUsdRmRate();
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const wallet = await getWallet(tid);
    const transactions = await prisma.walletTransaction.findMany({
      where: { tenantId: tid },
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

    const tid = req.user.tenantId;
    const amountSen = Math.round(amount * 100);
    const tx = await prisma.walletTransaction.create({
      data: { type: 'topup', amountSen, note: `Top-up RM ${amount.toFixed(2)}`, status: 'pending', tenantId: tid },
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

    const walletWhere = tx.tenantId
      ? { tenantId: tx.tenantId }
      : { id: 'global' };
    const existingWallet = await prisma.wallet.findFirst({ where: walletWhere });
    const walletId = existingWallet?.id || (tx.tenantId || 'global');

    await prisma.$transaction([
      prisma.walletTransaction.update({ where: { billplzId }, data: { status: 'paid' } }),
      prisma.wallet.upsert({
        where: { id: walletId },
        create: { id: walletId, ...(tx.tenantId ? { tenantId: tx.tenantId } : {}), balance: tx.amountSen },
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
    const tid = req.user.tenantId;
    // Include legacy records stored before tenantId was tracked (tagged as 'default')
    const tidFilter = tid !== 'default' ? { in: [tid, 'default'] } : 'default';
    const now = new Date();
    const allTime = req.query.all === '1';
    const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const start = allTime ? null : new Date(`${month}-01T00:00:00.000Z`);
    const end   = allTime ? null : new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const dateFilter = (field) => start ? { [field]: { gte: start, lt: end } } : {};

    const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const { rate, updatedAt: rateUpdatedAt } = await getLiveUsdRmRate();

    // Claude — exact from ApiUsageLog (real token costs)
    const claudeLog = await prisma.apiUsageLog.aggregate({
      where: { service: 'claude', tenantId: tidFilter, ...dateFilter('createdAt') },
      _sum: { costUsd: true, units: true },
      _count: { id: true },
    });

    const scraperLog = await prisma.apiUsageLog.aggregate({
      where: { service: 'outscraper', tenantId: tidFilter, ...dateFilter('createdAt') },
      _sum: { costUsd: true, units: true },
    });

    const [emailCount, waCount, enrichedCount] = await Promise.all([
      prisma.campaignAction.count({ where: { type: 'email', status: 'sent', tenantId: tidFilter, ...dateFilter('sentAt') } }),
      prisma.campaignAction.count({ where: { type: 'wa',    status: 'sent', tenantId: tidFilter, ...dateFilter('sentAt') } }),
      prisma.lead.count({ where: { enriched: true, tenantId: tidFilter, ...dateFilter('enrichedAt') } }),
    ]);

    // Vapi — fetch real call costs from their API
    let vapiCostUsd = 0;
    let vapiCount = 0;
    let vapiSource = 'none';
    try {
      const { getApiKey } = await import('../services/apiKeys.js');
      const vapiKey = await getApiKey('vapi');
      if (vapiKey) {
        const vapiUrl = start
          ? `https://api.vapi.ai/call?startedAtGt=${start.toISOString()}&startedAtLt=${end.toISOString()}&limit=1000`
          : `https://api.vapi.ai/call?limit=1000`;
        const r = await fetch(vapiUrl, {
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
      month: allTime ? 'all' : month,
      total,
      budget: settings?.monthlyBudget || 1000,
      usdRmRate: rate,
      rateUpdatedAt,
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
