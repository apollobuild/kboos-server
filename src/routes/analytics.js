import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
// GET /analytics/campaign/:id
router.get('/campaign/:id', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const campaignId = parseInt(req.params.id);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId, tenantId: tid } });
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    const [totalLeads, tierA, tierB, tierC, personalizedCount,
           emailActions, waActions, voiceActions,
           replies, meetings] = await Promise.all([
      prisma.lead.count({ where: { campaignId, tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, tier: 'A', tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, tier: 'B', tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, tier: 'C', tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, personalized: true, tenantId: tid } }),
      prisma.campaignAction.count({ where: { campaignId, type: 'email', tenantId: tid } }),
      prisma.campaignAction.count({ where: { campaignId, type: 'wa', tenantId: tid } }),
      prisma.campaignAction.count({ where: { campaignId, type: 'voice', tenantId: tid } }),
      prisma.reply.count({ where: { campaignId: campaignId, tenantId: tid } }).catch(() => 0),
      prisma.meetingLog.count({ where: { campaignId, tenantId: tid } }),
    ]);

    const emailOpens = await prisma.campaignAction.count({ where: { campaignId, type: 'email', openedAt: { not: null }, tenantId: tid } });
    const openRate = emailActions > 0 ? Math.round((emailOpens / emailActions) * 100) : 0;
    const replyRate = (emailActions + waActions) > 0 ? Math.round((replies / (emailActions + waActions)) * 100) : 0;

    // Latest optimization
    const optimization = await prisma.campaignOptimization.findFirst({ where: { campaignId, tenantId: tid }, orderBy: { analyzedAt: 'desc' } });

    res.json({
      campaign,
      stats: { totalLeads, tierA, tierB, tierC, personalizedCount, emailActions, waActions, voiceActions, emailOpens, openRate, replyRate, meetings, replies },
      optimization: optimization || null,
    });
  } catch (e) { next(e); }
});

// GET /analytics/campaign/:id/suggestions
router.get('/campaign/:id/suggestions', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const campaignId = parseInt(req.params.id);
    const opt = await prisma.campaignOptimization.findFirst({ where: { campaignId, tenantId: tid }, orderBy: { analyzedAt: 'desc' } });
    res.json(opt || { suggestions: [] });
  } catch (e) { next(e); }
});

// POST /analytics/campaign/:id/analyze — trigger on-demand Sonnet analysis
router.post('/campaign/:id/analyze', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.id);
    const { enqueue } = await import('../services/queue.js');
    await enqueue('optimization-loop', { campaignId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /analytics/overview — dashboard summary
router.get('/overview', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const [activeCampaigns, totalLeads, meetingsBooked, emailActions, waActions, voiceActions, recentActivity] = await Promise.all([
      prisma.campaign.count({ where: { status: 'active', tenantId: tid } }),
      prisma.lead.count({ where: { tenantId: tid } }),
      prisma.meetingLog.count({ where: { tenantId: tid } }),
      prisma.campaignAction.count({ where: { type: 'email', status: 'sent', tenantId: tid } }),
      prisma.campaignAction.count({ where: { type: 'wa', status: 'sent', tenantId: tid } }),
      prisma.campaignAction.count({ where: { type: { in: ['voice', 'call'] }, status: 'sent', tenantId: tid } }),
      prisma.activity.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, take: 6 }),
    ]);
    res.json({ activeCampaigns, totalLeads, meetingsBooked, emailActions, waActions, voiceActions, recentActivity });
  } catch (e) { next(e); }
});

// GET /analytics/campaigns/today — today stats for all active campaigns
router.get('/campaigns/today', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const activeCampaigns = await prisma.campaign.findMany({
      where: { status: 'active', startedAt: { not: null }, tenantId: tid },
      select: { id: true, name: true, bizName: true, dailyLimit: true },
    });

    const results = await Promise.all(activeCampaigns.map(async (c) => {
      const rows = await prisma.campaignAction.groupBy({
        by: ['type', 'status'],
        where: { campaignId: c.id, sentAt: { gte: todayStart }, tenantId: tid },
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

      const totalSent = Object.values(channels).reduce((s, ch) => s + ch.sent, 0);
      return { id: c.id, name: c.name, bizName: c.bizName, dailyLimit: c.dailyLimit || 200, channels, totalSent };
    }));

    res.json(results);
  } catch (e) { next(e); }
});

export default router;
