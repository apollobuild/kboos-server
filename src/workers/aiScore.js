import { PrismaClient } from '@prisma/client';
import { scoreLeadsWithAI } from '../services/claude.js';

const prisma = new PrismaClient();

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
    throw err;
  }

  for (const s of scored) {
    const aiTier = s.aiScore >= 70 ? 'A' : s.aiScore >= 40 ? 'B' : 'C';
    await prisma.lead.update({
      where: { id: s.leadId },
      data: {
        aiScore: s.aiScore,
        aiScoreReason: s.aiScoreReason,
        tier: aiTier,
      },
    });
  }

  // Update pipeline progress
  const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
  if (pipeline) {
    const newComplete = (pipeline.aiScoreComplete || 0) + leads.length;
    const total = pipeline.aiScoreTotal || newComplete;
    const isDone = newComplete >= total;

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: {
        aiScoreComplete: newComplete,
        ...(isDone ? { stage: 'ai_content_ready', aiScoredAt: new Date() } : {}),
      },
    });

    if (isDone) {
      console.log(`[AiScore] Campaign ${campaignId}: all ${total} leads scored — stage → ai_content_ready`);
    }
  }

  console.log(`[AiScore] Campaign ${campaignId}: batch of ${scored.length} leads scored`);
}
