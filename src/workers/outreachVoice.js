import { makeCall } from '../services/vapi.js';
import { injectPersonalization } from '../services/leadScoring.js';
import prisma from '../db.js';

export async function handleOutreachVoice(job) {
  const { leadId, campaignId, assetType, stepDay, actionId } = job.data;

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || ['unsubscribed', 'bounced'].includes(lead.status)) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'Lead unsubscribed/bounced' } });
    return;
  }

  const elig = await prisma.leadEligibility.findUnique({ where: { leadId_campaignId: { leadId, campaignId } } });
  if (elig && !elig.voiceEligible) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: elig.voiceReason } });
    return;
  }
  // The pipeline's channel-strategy step writes eligibility onto the lead itself
  if (lead.eligibilityChecked && !lead.voiceEligible) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'Not voice-eligible' } });
    return;
  }
  if (!lead.phone) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'failed', errorMsg: 'No phone' } });
    return;
  }

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const config = campaign.config || {};

  // Only approved assets are ever sent. Note: assetGen creates voice_warm /
  // voice_direct, not voice_opening, so the channel fallback is the usual path
  const asset = await prisma.campaignAsset.findFirst({ where: { campaignId, channel: 'voice', assetType: assetType || 'voice_warm', approved: true } })
    || await prisma.campaignAsset.findFirst({ where: { campaignId, channel: 'voice', approved: true }, orderBy: { id: 'asc' } });
  const personalization = await prisma.leadPersonalization.findUnique({ where: { leadId } });

  const voiceScript = asset ? injectPersonalization(asset.editedBody || asset.body, lead, personalization) : (config.voiceScript || '');

  try {
    await makeCall({ phone: lead.phone, leadName: lead.name, bizName: campaign.bizName, campaignScript: voiceScript });
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'sent', jobId: job.id } });
    await prisma.lead.update({ where: { id: leadId }, data: { lastContactedAt: new Date(), status: ['new','scraped','personalizing'].includes(lead.status) ? 'called' : lead.status } });
  } catch (err) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'failed', errorMsg: err.message, retryCount: { increment: 1 } } });
    throw err;
  }
}
