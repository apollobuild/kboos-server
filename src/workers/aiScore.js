import { scoreLeadsWithAI } from '../services/claude.js';
import prisma from '../db.js';

export async function handleAiScore(job) {
  const { campaignId, leadIds } = job.data;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const leads = await prisma.lead.findMany({
    where: { id: { in: leadIds } },
    select: {
      id: true, name: true, company: true, title: true, phone: true,
      email: true, website: true, address: true, category: true,
      rating: true, reviewCount: true, enriched: true, tier: true,
    },
  });

  if (!leads.length) return;

  let scored;
  try {
    const result = await scoreLeadsWithAI({ leads, campaign });
    scored = result.scored || [];
  } catch (err) {
    console.error(`[AiScore] Campaign ${campaignId} batch error:`, err.message);
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { lastError: `AI Scoring failed: ${err.message}` },
    }).catch(() => {});
    throw err;
  }

  const validIds = new Set(leads.map(l => l.id));
  for (const s of scored) {
    if (!validIds.has(s.leadId)) continue; // model returned an ID outside this batch — skip, don't kill the batch
    const aiTier = s.aiScore >= 70 ? 'A' : s.aiScore >= 40 ? 'B' : 'C';
    await prisma.lead.update({
      where: { id: s.leadId },
      data: {
        aiScore: s.aiScore,
        aiScoreReason: s.aiScoreReason,
        tier: aiTier,
      },
    }).catch(err => console.error(`[AiScore] Lead ${s.leadId} update failed:`, err.message));
  }

  // Update pipeline progress — atomic increment so concurrent batches don't lose counts
  const pipeline = await prisma.campaignPipeline.update({
    where: { campaignId },
    data: { aiScoreComplete: { increment: leads.length } },
  }).catch(() => null);

  if (pipeline) {
    const total = pipeline.aiScoreTotal || pipeline.aiScoreComplete;
    if (pipeline.aiScoreComplete >= total) {
      await prisma.campaignPipeline.update({
        where: { campaignId },
        data: { stage: 'ai_content_ready', aiScoredAt: new Date() },
      });
      console.log(`[AiScore] Campaign ${campaignId}: all ${total} leads scored — stage → ai_content_ready`);
    }
  }

  console.log(`[AiScore] Campaign ${campaignId}: batch of ${scored.length} leads scored`);
}
