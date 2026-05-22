import { PrismaClient } from '@prisma/client';
import { sendMessage, sendTemplate } from '../services/wati.js';
import { injectPersonalization } from '../services/leadScoring.js';

const prisma = new PrismaClient();

export async function handleOutreachWa(job) {
  const { leadId, campaignId, assetType, stepDay, actionId } = job.data;

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || ['unsubscribed', 'bounced'].includes(lead.status)) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'Lead unsubscribed/bounced' } });
    return;
  }

  const elig = await prisma.leadEligibility.findUnique({ where: { leadId_campaignId: { leadId, campaignId } } });
  if (elig && !elig.waEligible) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: elig.waReason } });
    return;
  }
  if (!lead.phone) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'No phone' } });
    return;
  }

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const config = campaign.config || {};

  const asset = await prisma.campaignAsset.findFirst({ where: { campaignId, assetType: assetType || 'wa_1' } })
    || await prisma.campaignAsset.findFirst({ where: { campaignId, channel: 'wa' }, orderBy: { id: 'asc' } });

  const personalization = await prisma.leadPersonalization.findUnique({ where: { leadId } });

  try {
    if (asset) {
      const message = injectPersonalization(asset.editedBody || asset.body, lead, personalization);
      await sendMessage({ phone: lead.phone, message });
    } else {
      const templateName = config.waTemplateName || 'kboos_intro_v1';
      const firstName = lead.name?.split(' ')[0] || lead.name;
      await sendTemplate({ phone: lead.phone, templateName, parameters: [{ name: 'first_name', value: firstName }] });
    }
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'sent', jobId: job.id } });
    await prisma.lead.update({ where: { id: leadId }, data: { lastContactedAt: new Date(), status: ['new','scraped','personalizing'].includes(lead.status) ? 'contacted' : lead.status } });
  } catch (err) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'failed', errorMsg: err.message, retryCount: { increment: 1 } } });
    throw err;
  }
}
