import { sendEmail } from '../services/sendgrid.js';
import { sendViaSMTP } from '../services/smtp.js';
import { injectPersonalization } from '../services/leadScoring.js';
import prisma from '../db.js';

export async function handleOutreachEmail(job) {
  const { leadId, campaignId, assetType, stepDay, actionId } = job.data;

  // Update action to sent (was created as pending by campaignRunner)
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || ['unsubscribed', 'bounced'].includes(lead.status)) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'Lead unsubscribed/bounced' } });
    return;
  }

  // Check eligibility
  const elig = await prisma.leadEligibility.findUnique({ where: { leadId_campaignId: { leadId, campaignId } } });
  if (elig && !elig.emailEligible) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: elig.emailReason } });
    return;
  }
  // The pipeline's channel-strategy step writes eligibility onto the lead itself
  if (lead.eligibilityChecked && !lead.emailEligible) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'Not email-eligible' } });
    return;
  }
  if (!lead.email) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'skipped', errorMsg: 'No email' } });
    return;
  }

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const config = campaign.config || {};

  // Get the asset — first try the specified assetType, fall back to email_1
  const asset = await prisma.campaignAsset.findFirst({
    where: { campaignId, assetType: assetType || 'email_1' },
  }) || await prisma.campaignAsset.findFirst({ where: { campaignId, channel: 'email' }, orderBy: { id: 'asc' } });

  const personalization = await prisma.leadPersonalization.findUnique({ where: { leadId } });

  let subject, body;
  if (asset) {
    body = injectPersonalization(asset.editedBody || asset.body, lead, personalization);
    subject = injectPersonalization(asset.subject || 'Quick question', lead, personalization);
  } else {
    // Fallback: no asset, use simple template
    const firstName = lead.name?.split(' ')[0] || lead.name;
    subject = `Quick question for ${lead.company}`;
    body = `Hi ${firstName},\n\nI came across ${lead.company} and wanted to reach out.\n\nWould you be open to a quick chat?\n\nBest,\n${config.fromName || campaign.bizName} Team`;
  }

  const fromName = config.fromName || `${campaign.bizName} Team`;
  const fromEmail = config.fromEmail || 'outreach@kboos.app';
  const replyTo = config.replyTo;

  try {
    if (config.smtp?.user && config.smtp?.pass) {
      await sendViaSMTP({ smtpConfig: config.smtp, to: lead.email, subject, body, fromName, replyTo });
    } else {
      await sendEmail({ to: lead.email, subject, body, fromName, fromEmail, replyTo });
    }
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'sent', jobId: job.id } });
    await prisma.lead.update({ where: { id: leadId }, data: { lastContactedAt: new Date(), status: ['new','scraped','personalizing'].includes(lead.status) ? 'emailed' : lead.status } });
  } catch (err) {
    if (actionId) await prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'failed', errorMsg: err.message, retryCount: { increment: 1 } } });
    throw err;
  }
}
