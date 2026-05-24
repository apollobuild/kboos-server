import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { generateBrief, generateEmail, generateFromOffer, suggestReply, testConnection, generateCampaignFromGoal, analyzeCampaignPerformance, prioritizeLeads, generateSmartFollowup, generateOutreachAssets, generateWASequence } from '../services/claude.js';
import { getApiKey } from '../services/apiKeys.js';
import { getCache, setCache, hashInput } from '../services/aiCache.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const router = Router();

router.post('/generate-brief', requireAuth, async (req, res, next) => {
  try { res.json(await generateBrief(req.body)); } catch (e) { next(e); }
});

router.post('/generate-email', requireAuth, async (req, res, next) => {
  try { res.json(await generateEmail(req.body)); } catch (e) { next(e); }
});

router.post('/generate-from-offer', requireAuth, async (req, res, next) => {
  try { res.json(await generateFromOffer(req.body)); } catch (e) { next(e); }
});

router.post('/suggest-reply', requireAuth, async (req, res, next) => {
  try {
    const result = await suggestReply(req.body);
    // suggestReply now returns { reply, stage, escalate } — extract text for backward compat
    const reply = typeof result === 'string' ? result : result.reply;
    res.json({ reply });
  } catch (e) { next(e); }
});

router.get('/test', requireAuth, async (req, res, next) => {
  try {
    const key = await getApiKey('claude');
    if (!key) return res.json({ ok: false, error: 'No key saved' });
    const ok = await testConnection(key);
    res.json({ ok });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/generate-campaign', requireAuth, async (req, res, next) => {
  try {
    const { bizId, goal } = req.body;
    const biz = await prisma.business.findUnique({ where: { id: bizId } });
    const seq = await prisma.businessSequence.findUnique({ where: { bizId } });
    const brief = seq?.brief || {};
    const result = await generateCampaignFromGoal({ bizId, goal, brief, industry: biz?.industry || '' });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/campaign-performance/:id', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.id);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const now = new Date();
    const daysRunning = campaign.startedAt
      ? Math.floor((now - new Date(campaign.startedAt)) / (1000 * 60 * 60 * 24))
      : 0;

    const [totalSent, hotCount, emailBounces] = await Promise.all([
      prisma.campaignAction.count({ where: { campaignId, status: 'sent' } }),
      prisma.lead.count({ where: { campaignId, status: 'hot' } }),
      prisma.campaignAction.count({ where: { campaignId, status: 'failed', type: 'email' } }),
    ]);
    const openRate = campaign.open ? parseFloat(campaign.open) || 0 : 0;
    const stats = { daysRunning, totalLeads: campaign.leads, totalSent, openRate, waResponseRate: 0, hotCount, emailBounces };

    const inputHash = hashInput({ campaignId, stats });
    const cached = await getCache('campaign', String(campaignId), 'performance', inputHash);
    if (cached) return res.json({ ...cached, fromCache: true });

    const seq = await prisma.businessSequence.findUnique({ where: { bizId: campaign.bizId } });
    const result = await analyzeCampaignPerformance({ campaign, stats, brief: seq?.brief || {} });
    await setCache('campaign', String(campaignId), 'performance', result, inputHash, 4);
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/prioritize-leads', requireAuth, async (req, res, next) => {
  try {
    const { campaignId, leadIds } = req.body;
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const where = { campaignId, status: { notIn: ['unsubscribed', 'bounced'] } };
    if (leadIds?.length) where.id = { in: leadIds };
    const leads = await prisma.lead.findMany({ where, take: 200 });

    const inputHash = hashInput({ campaignId, leadCount: leads.length, leadIds: leads.map(l => l.id) });
    const cached = await getCache('campaign', String(campaignId), 'lead_priority', inputHash);
    if (cached) return res.json({ ...cached, fromCache: true });

    const seq = await prisma.businessSequence.findUnique({ where: { bizId: campaign.bizId } });
    const result = await prioritizeLeads({ leads, campaign, brief: seq?.brief || {} });

    // persist scores to DB
    if (result.ranked) {
      await Promise.all(result.ranked.map(r =>
        prisma.lead.update({
          where: { id: r.leadId },
          data: { aiPriorityScore: r.priorityScore, aiPriorityNote: r.signals?.join('; ') || '', aiNextAction: r.suggestedAction, aiPrioritizedAt: new Date() },
        }).catch(() => {})
      ));
    }

    await setCache('campaign', String(campaignId), 'lead_priority', result, inputHash, 6);
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/generate-assets', requireAuth, async (req, res, next) => {
  try { res.json(await generateOutreachAssets(req.body)); } catch (e) { next(e); }
});

router.post('/smart-followup', requireAuth, async (req, res, next) => {
  try {
    const { leadId, channel } = req.body;
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const campaign = lead.campaignId
      ? await prisma.campaign.findUnique({ where: { id: lead.campaignId } })
      : null;
    const seq = campaign
      ? await prisma.businessSequence.findUnique({ where: { bizId: campaign.bizId } })
      : null;

    const actions = await prisma.campaignAction.findMany({
      where: { leadId },
      orderBy: { sentAt: 'asc' },
      take: 10,
    });
    const history = actions.map(a => `Day ${a.stepDay}: ${a.type} — ${a.status}`).join('\n');

    const result = await generateSmartFollowup({ lead, campaign: campaign || {}, brief: seq?.brief || {}, history, channel });
    res.json(result);
  } catch (e) { next(e); }
});

// POST /ai/wa-sequence — generate WhatsApp message sequence from a goal
router.post('/wa-sequence', requireAuth, async (req, res, next) => {
  try {
    const { goal, steps = 3 } = req.body;
    if (!goal) return res.status(400).json({ error: 'goal required' });
    const key = await hashInput(`wa-seq:${goal}:${steps}`);
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const result = await generateWASequence({ goal, steps });
    await setCache(key, result, 60);
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
