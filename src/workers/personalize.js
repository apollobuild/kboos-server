import { PrismaClient } from '@prisma/client';
import { batchPersonalizeLeads } from '../services/claude.js';

const prisma = new PrismaClient();

export async function handlePersonalize(job) {
  const { campaignId, leadIds } = job.data;

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const seq = await prisma.businessSequence.findUnique({ where: { bizId: campaign.bizId } }).catch(() => null);
  const brief = seq?.brief || {};
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } } });

  if (leads.length === 0) return;

  let results;
  try {
    results = await batchPersonalizeLeads({
      bizName: campaign.bizName,
      offer: brief.offer || brief.service || '',
      dreamOutcome: brief.dreamOutcome || '',
      targetAudience: brief.audience || '',
      batch: leads.map(l => ({ id: l.id, name: l.name, company: l.company, category: l.category || l.title || '', city: l.address?.split(',')[1]?.trim() || '', rating: l.score || 0 })),
    });
  } catch (err) {
    throw err;
  }

  for (const r of (results.personalized || [])) {
    await prisma.leadPersonalization.upsert({
      where: { leadId: r.leadId },
      update: { openingLine: r.openingLine, variables: r.variables || {}, generatedAt: new Date() },
      create: { leadId: r.leadId, campaignId, openingLine: r.openingLine, variables: r.variables || {} },
    });
    await prisma.lead.update({ where: { id: r.leadId }, data: { personalized: true, personalizedAt: new Date() } });
  }

  // Update pipeline progress
  const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
  if (pipeline) {
    const newComplete = (pipeline.personalizeComplete || 0) + leads.length;
    const total = pipeline.personalizeTotal || newComplete;
    const isDone = newComplete >= total;
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { personalizeComplete: newComplete, ...(isDone ? { stage: 'personalized', personalizedAt: new Date() } : {}) },
    });
  }

  console.log(`[Personalize] Campaign ${campaignId}: batch of ${leads.length} done`);
}
