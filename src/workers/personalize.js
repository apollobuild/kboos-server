import { batchPersonalizeLeads } from '../services/claude.js';
import prisma from '../db.js';

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
    console.error(`[Personalize] Campaign ${campaignId} batch error:`, err.message);
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { lastError: `Personalization failed: ${err.message}` },
    }).catch(() => {});
    throw err;
  }

  const validIds = new Set(leads.map(l => l.id));
  for (const r of (results.personalized || [])) {
    if (!validIds.has(r.leadId)) continue; // model returned an ID outside this batch — skip, don't kill the batch
    try {
      await prisma.leadPersonalization.upsert({
        where: { leadId: r.leadId },
        update: { openingLine: r.openingLine, variables: r.variables || {}, generatedAt: new Date() },
        create: { leadId: r.leadId, campaignId, openingLine: r.openingLine, variables: r.variables || {} },
      });
      await prisma.lead.update({ where: { id: r.leadId }, data: { personalized: true, personalizedAt: new Date() } });
    } catch (err) {
      console.error(`[Personalize] Lead ${r.leadId} update failed:`, err.message);
    }
  }

  // Update pipeline progress — atomic increment so concurrent batches don't lose counts
  const pipeline = await prisma.campaignPipeline.update({
    where: { campaignId },
    data: { personalizeComplete: { increment: leads.length } },
  }).catch(() => null);

  if (pipeline) {
    const total = pipeline.personalizeTotal || pipeline.personalizeComplete;
    if (pipeline.personalizeComplete >= total) {
      await prisma.campaignPipeline.update({
        where: { campaignId },
        data: { stage: 'channels_configured', personalizedAt: new Date() },
      });
    }
  }

  console.log(`[Personalize] Campaign ${campaignId}: batch of ${leads.length} done`);
}
