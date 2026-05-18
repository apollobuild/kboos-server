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
