import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    res.json(await prisma.campaign.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'asc' } }));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const data = {
      ...req.body,
      tenantId: tid,
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
    const tid = req.user.tenantId;
    const c = await prisma.campaign.findUnique({ where: { id: parseInt(req.params.id), tenantId: tid } });
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const next_status = c.status === 'active' ? 'paused' : 'active';
    const updated = await prisma.campaign.update({ where: { id: c.id }, data: { status: next_status } });
    await prisma.activity.create({ data: {
      color: next_status === 'active' ? 'green' : 'amber',
      msg: `Campaign "${c.name}" ${next_status === 'active' ? 'resumed' : 'paused'}`,
      tag: 'Campaigns',
      tenantId: tid,
    }}).catch(() => {});
    res.json(updated);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const data = { ...req.body };
    // Map snake_case aliases
    if (req.body.target_audience && !req.body.targetAudience) data.targetAudience = req.body.target_audience;
    res.json(await prisma.campaign.update({ where: { id: parseInt(req.params.id), tenantId: tid }, data }));
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    await prisma.campaign.delete({ where: { id: parseInt(req.params.id), tenantId: tid } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /campaigns/:id/start — launch campaign, engine takes over
router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const rawLimit = parseInt(req.body.dailyLimit) || 200;
    const dailyLimit = Math.max(50, Math.min(500, rawLimit));
    const campaign = await prisma.campaign.update({
      where: { id: parseInt(req.params.id), tenantId: tid },
      data: { status: 'active', startedAt: new Date(), dailyLimit },
    });
    await prisma.activity.create({ data: {
      color: 'green',
      msg: `Campaign "${campaign.name}" launched — engine running at ${dailyLimit}/day`,
      tag: 'Campaigns',
      tenantId: tid,
    }}).catch(() => {});
    res.json(campaign);
  } catch (e) { next(e); }
});

// GET /campaigns/:id/actions — action log
router.get('/:id/actions', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const actions = await prisma.campaignAction.findMany({
      where: { campaignId: parseInt(req.params.id), tenantId: tid },
      orderBy: { sentAt: 'desc' },
      take: 200,
    });
    res.json(actions);
  } catch (e) { next(e); }
});

// GET /campaigns/:id/actions/today — daily send progress for dashboard
router.get('/:id/actions/today', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const campaignId = parseInt(req.params.id);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId, tenantId: tid } });
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    const rows = await prisma.campaignAction.groupBy({
      by: ['type', 'status'],
      where: { campaignId, tenantId: tid, sentAt: { gte: todayStart } },
      _count: { id: true },
    });

    const channels = {
      email: { sent: 0, failed: 0, pending: 0 },
      wa:    { sent: 0, failed: 0, pending: 0 },
      voice: { sent: 0, failed: 0, pending: 0 },
    };
    for (const row of rows) {
      const key = row.type === 'call' ? 'voice' : row.type;
      if (channels[key] && row.status in channels[key]) {
        channels[key][row.status] = row._count.id;
      }
    }

    const totalSent    = Object.values(channels).reduce((s, c) => s + c.sent, 0);
    const totalPending = Object.values(channels).reduce((s, c) => s + c.pending, 0);
    const totalFailed  = Object.values(channels).reduce((s, c) => s + c.failed, 0);

    res.json({
      channels,
      totalSent,
      totalPending,
      totalFailed,
      dailyLimit: campaign.dailyLimit || 200,
    });
  } catch (e) { next(e); }
});

export default router;
