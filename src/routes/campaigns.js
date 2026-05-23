import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.campaign.findMany({ orderBy: { createdAt: 'asc' } })); } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const data = {
      ...req.body,
      offer: req.body.offer || '',
      goal: req.body.goal || '',
      targetAudience: req.body.targetAudience || req.body.target_audience || '',
      personalizationLevel: req.body.personalizationLevel || 2,
      leadSource: req.body.leadSource || 'gmaps',
      channelStrategy: req.body.channelStrategy || null,
    };
    res.json(await prisma.campaign.create({ data }));
  } catch (e) { next(e); }
});

router.patch('/:id/toggle', requireAuth, async (req, res, next) => {
  try {
    const c = await prisma.campaign.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const next_status = c.status === 'active' ? 'paused' : 'active';
    const updated = await prisma.campaign.update({ where: { id: c.id }, data: { status: next_status } });
    await prisma.activity.create({ data: {
      color: next_status === 'active' ? 'green' : 'amber',
      msg: `Campaign "${c.name}" ${next_status === 'active' ? 'resumed' : 'paused'}`,
      tag: 'Campaigns',
    }}).catch(() => {});
    res.json(updated);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const data = { ...req.body };
    // Map snake_case aliases
    if (req.body.target_audience && !req.body.targetAudience) data.targetAudience = req.body.target_audience;
    res.json(await prisma.campaign.update({ where: { id: parseInt(req.params.id) }, data }));
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try { await prisma.campaign.delete({ where: { id: parseInt(req.params.id) } }); res.json({ ok: true }); } catch (e) { next(e); }
});

// POST /campaigns/:id/start — launch campaign, engine takes over
router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const rawLimit = parseInt(req.body.dailyLimit) || 200;
    const dailyLimit = Math.max(50, Math.min(500, rawLimit));
    const campaign = await prisma.campaign.update({
      where: { id: parseInt(req.params.id) },
      data: { status: 'active', startedAt: new Date(), dailyLimit },
    });
    await prisma.activity.create({ data: {
      color: 'green',
      msg: `Campaign "${campaign.name}" launched — engine running at ${dailyLimit}/day`,
      tag: 'Campaigns',
    }}).catch(() => {});
    res.json(campaign);
  } catch (e) { next(e); }
});

// GET /campaigns/:id/actions — action log
router.get('/:id/actions', requireAuth, async (req, res, next) => {
  try {
    const actions = await prisma.campaignAction.findMany({
      where: { campaignId: parseInt(req.params.id) },
      orderBy: { sentAt: 'desc' },
      take: 200,
    });
    res.json(actions);
  } catch (e) { next(e); }
});

export default router;
