import { PrismaClient } from '@prisma/client';
import { scoreLeadQuality } from '../services/leadScoring.js';
import { enqueue } from '../services/queue.js';

const prisma = new PrismaClient();

export async function handleValidation(job) {
  const { campaignId } = job.data;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  await prisma.campaignPipeline.upsert({
    where: { campaignId },
    update: { stage: 'validating', lastError: null },
    create: { campaignId, stage: 'validating' },
  });

  const leads = await prisma.lead.findMany({ where: { campaignId }, select: { id: true, phone: true, email: true, website: true, category: true, company: true, title: true, address: true } });

  if (leads.length === 0) {
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'validated', tierA: 0, tierB: 0, tierC: 0, validatedAt: new Date() } });
    return;
  }

  const cfg = campaign.config || {};
  let tierA = 0, tierB = 0, tierC = 0;
  const scored = leads.map(lead => {
    const result = scoreLeadQuality(lead, cfg);
    if (result.tier === 'A') tierA++;
    else if (result.tier === 'B') tierB++;
    else tierC++;
    return { leadId: lead.id, ...result };
  });

  // Batch upsert LeadScore records
  for (const s of scored) {
    await prisma.leadScore.upsert({
      where: { leadId: s.leadId },
      update: { tier: s.tier, qualityScore: s.qualityScore, signals: s.signals, hasWebsite: s.hasWebsite, hasPhone: s.hasPhone, hasEmail: s.hasEmail, categoryMatch: s.categoryMatch, ratingOk: s.ratingOk, scoredAt: new Date() },
      create: { leadId: s.leadId, tier: s.tier, qualityScore: s.qualityScore, signals: s.signals, hasWebsite: s.hasWebsite, hasPhone: s.hasPhone, hasEmail: s.hasEmail, categoryMatch: s.categoryMatch, ratingOk: s.ratingOk },
    });
    await prisma.lead.update({ where: { id: s.leadId }, data: { tier: s.tier, validationScore: s.qualityScore } });
  }

  await prisma.campaignPipeline.update({
    where: { campaignId },
    data: { stage: 'validated', tierA, tierB, tierC, scrapeTotal: leads.length, validatedAt: new Date() },
  });

  console.log(`[Validation] Campaign ${campaignId}: A=${tierA} B=${tierB} C=${tierC}`);
}
