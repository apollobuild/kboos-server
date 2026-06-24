import { sendMessage, sendTemplate } from '../services/wati.js';
import { injectPersonalization } from '../services/leadScoring.js';
import { isValidMobile } from '../services/tenantConfig.js';
import { recordSendFailure } from '../engine/circuitBreaker.js';
import prisma from '../db.js';

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
  // The pipeline's channel-strategy step writes eligibility onto the lead itself
  if (lead.eligibilityChecked && !lead.waEligible) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'Not WhatsApp-eligible' } });
    return;
  }
  if (!lead.phone) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'No phone' } });
    return;
  }
  if (!isValidMobile(lead.phone)) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'Landline or invalid mobile — not on WhatsApp' } });
    return;
  }

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const config = campaign.config || {};
  const firstName = lead.name?.split(' ')[0] || lead.name || '';

  // WhatsApp rule: a free-form message is only allowed inside the 24h window
  // AFTER the lead replies. Otherwise we MUST send an approved template.
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const recentReply = await prisma.reply.findFirst({
    where: { leadId, channel: { in: ['wa', 'whatsapp'] }, createdAt: { gt: dayAgo } },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null);
  const sessionOpen = !!recentReply;

  const personalization = await prisma.leadPersonalization.findUnique({ where: { leadId } });

  try {
    if (sessionOpen) {
      // Inside the 24h window — send the rich, AI-personalized free-form message
      const asset = await prisma.campaignAsset.findFirst({ where: { campaignId, assetType: assetType || 'wa_1', approved: true } })
        || await prisma.campaignAsset.findFirst({ where: { campaignId, channel: 'wa', approved: true }, orderBy: { id: 'asc' } });
      const message = asset
        ? injectPersonalization(asset.editedBody || asset.body, lead, personalization)
        : `Hi ${firstName}, just following up — let me know if you'd like to hear more.`;
      await sendMessage({ phone: lead.phone, message });
    } else {
      // Cold / outside window — an approved WATI template is required
      const templateName = config.waTemplateName;
      if (!templateName) {
        throw new Error('No WhatsApp template set. Add the approved WATI template name in the campaign launch settings (Sending Settings → WhatsApp Template) before sending cold messages.');
      }
      await sendTemplate({
        phone: lead.phone,
        templateName,
        // {{1}} = first name (the recommended single-variable cold template)
        parameters: [{ name: '1', value: firstName }],
        // WATI silently drops a re-used broadcast_name (only the first send of a
        // given name fires), so make it unique per send
        broadcastName: `kboos_c${campaignId}_l${leadId}_${Date.now()}`,
      });
    }
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'sent', jobId: job.id } });
    await prisma.lead.update({ where: { id: leadId }, data: { lastContactedAt: new Date(), status: ['new','scraped','personalizing'].includes(lead.status) ? 'contacted' : lead.status } });
  } catch (err) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'failed', errorMsg: err.message, retryCount: { increment: 1 } } });
    await recordSendFailure(campaignId, err.message);
    throw err;
  }
}
