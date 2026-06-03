import { generateOptimizationSuggestions } from '../services/claude.js';
import prisma from '../db.js';

export async function handleOptimize(job) {
  const { campaignId } = job.data;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  // Gather metrics
  const [emailActions, waActions, voiceActions, replies, meetings] = await Promise.all([
    prisma.campaignAction.count({ where: { campaignId, type: 'email' } }),
    prisma.campaignAction.count({ where: { campaignId, type: 'wa' } }),
    prisma.campaignAction.count({ where: { campaignId, type: 'voice' } }),
    prisma.reply.count({ where: { campaignId } }).catch(() => 0),
    prisma.meetingLog.count({ where: { campaignId } }).catch(() => 0),
  ]);

  const emailOpens = await prisma.campaignAction.count({
    where: { campaignId, type: 'email', openedAt: { not: null } },
  }).catch(() => 0);

  const openRate = emailActions > 0 ? Math.round((emailOpens / emailActions) * 100) : 0;
  const totalSent = emailActions + waActions;
  const replyRate = totalSent > 0 ? Math.round((replies / totalSent) * 100) : 0;

  const startedAt = campaign.startedAt || campaign.createdAt;
  const daysRunning = startedAt
    ? Math.max(1, Math.ceil((Date.now() - new Date(startedAt).getTime()) / 86400000))
    : 1;

  // Tier breakdown
  const [tierA, tierB, tierC] = await Promise.all([
    prisma.lead.count({ where: { campaignId, tier: 'A' } }),
    prisma.lead.count({ where: { campaignId, tier: 'B' } }),
    prisma.lead.count({ where: { campaignId, tier: 'C' } }),
  ]);

  const metrics = {
    emailsSent: emailActions,
    waSent: waActions,
    callsMade: voiceActions,
    openRate,
    replyRate,
    meetingsBooked: meetings,
    daysRunning,
    tierBreakdown: { A: tierA, B: tierB, C: tierC },
  };

  let suggestions = [];
  try {
    const result = await generateOptimizationSuggestions({ campaign, metrics });
    suggestions = result.suggestions || [];
  } catch (err) {
    console.error(`[Optimize] Campaign ${campaignId} AI error:`, err.message);
    suggestions = [{ priority: 1, category: 'targeting', title: 'Analysis unavailable', detail: err.message, impact: 'low' }];
  }

  // Upsert CampaignOptimization record
  await prisma.campaignOptimization.upsert({
    where: { campaignId },
    update: {
      suggestions,
      metrics: { emailsSent: emailActions, waSent: waActions, callsMade: voiceActions, openRate, replyRate, meetingsBooked: meetings, daysRunning },
      analyzedAt: new Date(),
    },
    create: {
      campaignId,
      suggestions,
      metrics: { emailsSent: emailActions, waSent: waActions, callsMade: voiceActions, openRate, replyRate, meetingsBooked: meetings, daysRunning },
      analyzedAt: new Date(),
    },
  });

  await prisma.activity.create({
    data: {
      color: 'purple',
      msg: `Optimization analysis complete for campaign "${campaign.name}" — ${suggestions.length} suggestions`,
      tag: 'AI',
    },
  }).catch(() => {});

  console.log(`[Optimize] Campaign ${campaignId}: ${suggestions.length} suggestions generated`);
}
