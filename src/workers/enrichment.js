import { enrichLead } from '../services/apollo.js';
import prisma from '../db.js';

export async function handleEnrichment(job) {
  const { leadId, campaignId } = job.data;

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.enriched) return;

  try {
    const enriched = await enrichLead({ companyName: lead.company, city: lead.address?.split(',')[1]?.trim() || '' });
    if (enriched) {
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          name: enriched.decisionMakerName || lead.name,
          title: enriched.title || lead.title,
          email: enriched.email || lead.email,
          phone: enriched.mobile || lead.phone,
          enriched: true,
          enrichedAt: new Date(),
          enrichmentNote: `Apollo: ${enriched.confidence || 'found'}`,
        },
      });
    } else {
      await prisma.lead.update({ where: { id: leadId }, data: { enriched: true, enrichedAt: new Date(), enrichmentNote: 'No match found' } });
    }
  } catch (err) {
    await prisma.lead.update({ where: { id: leadId }, data: { enrichmentNote: `Error: ${err.message}` } });
    throw err;
  }

  // Check if all leads in campaign are enriched → update pipeline
  const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
  if (pipeline) {
    const newComplete = (pipeline.enrichComplete || 0) + 1;
    const total = pipeline.enrichTotal || newComplete;
    const isDone = newComplete >= total;
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { enrichComplete: newComplete, ...(isDone ? { stage: 'enrichment_complete', enrichedAt: new Date() } : {}) },
    });
  }
}
