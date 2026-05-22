import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'crypto';

const router = Router();
const prisma = new PrismaClient();

// Internal: generate a one-time onboard link for a business
router.post('/generate-token', requireAuth, async (req, res, next) => {
  try {
    const { bizId } = req.body;
    if (!bizId) return res.status(400).json({ error: 'bizId required' });

    const biz = await prisma.business.findUnique({ where: { id: bizId } });
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    // Expire any existing unused tokens for this biz
    await prisma.onboardToken.updateMany({
      where: { bizId, used: false },
      data: { used: true, usedAt: new Date() },
    });

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const created = await prisma.onboardToken.create({
      data: { bizId, bizName: biz.name, token, expiresAt },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.json({ token: created.token, url: `${frontendUrl}/onboard/${created.token}`, expiresAt });
  } catch (e) { next(e); }
});

// Internal: get active link for a business (if any)
router.get('/link/:bizId', requireAuth, async (req, res, next) => {
  try {
    const token = await prisma.onboardToken.findFirst({
      where: { bizId: req.params.bizId, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!token) return res.json({ url: null });
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.json({ token: token.token, url: `${frontendUrl}/onboard/${token.token}`, expiresAt: token.expiresAt });
  } catch (e) { next(e); }
});

// Public: resolve token → biz name (no auth)
router.get('/token/:token', async (req, res, next) => {
  try {
    const record = await prisma.onboardToken.findUnique({ where: { token: req.params.token } });
    if (!record) return res.status(404).json({ error: 'Link not found' });
    if (record.used) return res.status(410).json({ error: 'This link has already been used' });
    if (record.expiresAt && record.expiresAt < new Date()) return res.status(410).json({ error: 'This link has expired' });
    res.json({ bizId: record.bizId, bizName: record.bizName });
  } catch (e) { next(e); }
});

// Public: submit onboard form (no auth) — marks token used, saves brief
router.post('/submit/:token', async (req, res, next) => {
  try {
    const record = await prisma.onboardToken.findUnique({ where: { token: req.params.token } });
    if (!record) return res.status(404).json({ error: 'Link not found' });
    if (record.used) return res.status(410).json({ error: 'This link has already been used' });
    if (record.expiresAt && record.expiresAt < new Date()) return res.status(410).json({ error: 'Link has expired' });

    const brief = req.body; // full form data

    await prisma.$transaction([
      prisma.onboardToken.update({
        where: { token: req.params.token },
        data: { used: true, usedAt: new Date() },
      }),
      prisma.businessSequence.upsert({
        where: { bizId: record.bizId },
        create: { bizId: record.bizId, brief, status: 'review' },
        update: { brief, status: 'review', updatedAt: new Date() },
      }),
    ]);

    res.json({ ok: true, bizId: record.bizId });
  } catch (e) { next(e); }
});

// Internal: team fills form directly (no token needed)
router.post('/internal/:bizId', requireAuth, async (req, res, next) => {
  try {
    const { bizId } = req.params;
    const biz = await prisma.business.findUnique({ where: { id: bizId } });
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const brief = req.body;

    await prisma.businessSequence.upsert({
      where: { bizId },
      create: { bizId, brief, status: 'review' },
      update: { brief, status: 'review', updatedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
