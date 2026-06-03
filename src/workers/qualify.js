import { scoreLeadQuality } from '../services/leadScoring.js';
import prisma from '../db.js';

export async function handleQualify(job) {
  const { campaignId } = job.data;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const leads = await prisma.lead.findMany({
    where: { campaignId },
    select: { id: true, phone: true, email: true, website: true, category: true, company: true, title: true, address: true, rating: true, reviewCount: true },
  });

  if (leads.length === 0) {
    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'ready_for_enrichment', tierA: 0, tierB: 0, tierC: 0, qualifyTotal: 0, qualifyComplete: 0, qualifiedAt: new Date() },
      create: { campaignId, stage: 'ready_for_enrichment', tierA: 0, tierB: 0, tierC: 0, qualifyTotal: 0, qualifyComplete: 0, qualifiedAt: new Date() },
    });
    return;
  }

  const cfg = campaign.config || {};
  let tierA = 0, tierB = 0, tierC = 0;

  for (const lead of leads) {
    const result = scoreLeadQuality(lead, cfg);

    if (result.tier === 'A') tierA++;
    else if (result.tier === 'B') tierB++;
    else tierC++;

    // Update lead with quality score and tier
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        rawQualityScore: result.qualityScore,
        tier: result.tier,
        validationScore: result.qualityScore,
        status: 'qualified',
      },
    });

    // Upsert LeadScore record
    await prisma.leadScore.upsert({
      where: { leadId: lead.id },
      update: {
        tier: result.tier,
        qualityScore: result.qualityScore,
        signals: result.signals,
        hasWebsite: result.hasWebsite,
        hasPhone: result.hasPhone,
        hasEmail: result.hasEmail,
        categoryMatch: result.categoryMatch,
        ratingOk: result.ratingOk,
        scoredAt: new Date(),
      },
      create: {
        leadId: lead.id,
        tier: result.tier,
        qualityScore: result.qualityScore,
        signals: result.signals,
        hasWebsite: result.hasWebsite,
        hasPhone: result.hasPhone,
        hasEmail: result.hasEmail,
        categoryMatch: result.categoryMatch,
        ratingOk: result.ratingOk,
      },
    });
  }

  await prisma.campaignPipeline.upsert({
    where: { campaignId },
    update: {
      stage: 'ready_for_enrichment',
      tierA,
      tierB,
      tierC,
      qualifyTotal: leads.length,
      qualifyComplete: leads.length,
      qualifiedAt: new Date(),
    },
    create: {
      campaignId,
      stage: 'ready_for_enrichment',
      tierA,
      tierB,
      tierC,
      qualifyTotal: leads.length,
      qualifyComplete: leads.length,
      qualifiedAt: new Date(),
    },
  });

  console.log(`[Qualify] Campaign ${campaignId}: A=${tierA} B=${tierB} C=${tierC} total=${leads.length}`);
}
