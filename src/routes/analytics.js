import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

// GET /analytics/campaign/:id
router.get('/campaign/:id', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.id);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    const [totalLeads, tierA, tierB, tierC, personalizedCount,
           emailActions, waActions, voiceActions,
           replies, meetings] = await Promise.all([
      prisma.lead.count({ where: { campaignId } }),
      prisma.lead.count({ where: { campaignId, tier: 'A' } }),
      prisma.lead.count({ where: { campaignId, tier: 'B' } }),
      prisma.lead.count({ where: { campaignId, tier: 'C' } }),
      prisma.lead.count({ where: { campaignId, personalized: true } }),
      prisma.campaignAction.count({ where: { campaignId, type: 'email' } }),
      prisma.campaignAction.count({ where: { campaignId, type: 'wa' } }),
      prisma.campaignAction.count({ where: { campaignId, type: 'voice' } }),
      prisma.reply.count({ where: { campaignId: campaignId } }).catch(() => 0),
      prisma.meetingLog.count({ where: { campaignId } }),
    ]);

    const emailOpens = await prisma.campaignAction.count({ where: { campaignId, type: 'email', openedAt: { not: null } } });
    const openRate = emailActions > 0 ? Math.round((emailOpens / emailActions) * 100) : 0;
    const replyRate = (emailActions + waActions) > 0 ? Math.round((replies / (emailActions + waActions)) * 100) : 0;

    // Latest optimization
    const optimization = await prisma.campaignOptimization.findFirst({ where: { campaignId }, orderBy: { analyzedAt: 'desc' } });

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
    const campaignId = parseInt(req.params.id);
    const opt = await prisma.campaignOptimization.findFirst({ where: { campaignId }, orderBy: { analyzedAt: 'desc' } });
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

export default router;
