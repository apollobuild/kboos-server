import { PrismaClient } from '@prisma/client';
import { processAutoReply } from '../services/autoReply.js';
import { sendMessage } from '../services/wati.js';
import { sendEmail } from '../services/sendgrid.js';
import { sendViaSMTP } from '../services/smtp.js';

const prisma = new PrismaClient();

function isWithinSendWindow() {
  const klOffset = 8 * 60;
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const klMinutes = (utcMinutes + klOffset) % (24 * 60);
  return klMinutes >= 9 * 60 && klMinutes < 18 * 60;
}

export async function handleAutoReply(job) {
  const { replyId, leadId } = job.data;

  // Check settings
  const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } }).catch(() => null);
  const config = settings?.autoReplyConfig || {};
  if (!config.enabled) return;

  const reply = await prisma.reply.findUnique({ where: { id: replyId } }).catch(() => null);
  if (!reply) return;
  if (reply.aiStage === 'human') return; // human took over, skip

  const lead = leadId
    ? await prisma.lead.findUnique({ where: { id: leadId } }).catch(() => null)
    : null;
  if (!lead) return;

  if (['unsubscribed', 'bounced'].includes(lead.status)) return;

  // Count AI replies already in thread
  const thread = Array.isArray(reply.thread) ? reply.thread : [];
  const aiReplyCount = thread.filter(t => t.sentBy === 'ai').length;
  const maxReplies = config.maxReplies || 5;

  // Look up business context
  const biz = reply.bizId
    ? await prisma.business.findUnique({ where: { id: reply.bizId } }).catch(() => null)
    : null;

  const campaign = lead.campaignId
    ? await prisma.campaign.findUnique({ where: { id: lead.campaignId } }).catch(() => null)
    : null;

  const seq = biz
    ? await prisma.businessSequence.findUnique({ where: { bizId: biz.id } }).catch(() => null)
    : null;

  const brief = seq?.brief || campaign?.config || {};

  const result = await processAutoReply({ reply, lead, biz, brief, threadHistory: thread, aiReplyCount, maxReplies });
  if (!result) return;

  const now = new Date();
  const threadEntry = {
    role:   result.shouldSend ? 'ai' : 'system',
    msg:    result.shouldSend ? result.response : `[${result.reason}]`,
    ts:     now.toISOString(),
    sentBy: 'ai',
    stage:  result.stage,
  };

  // Update reply record
  await prisma.reply.update({
    where: { id: replyId },
    data: {
      aiStage:    result.stage,
      aiEscalate: result.shouldEscalate,
      aiDraft:    result.shouldSend ? result.response : (reply.aiDraft || null),
      thread:     [...thread, threadEntry],
      ...(result.shouldEscalate && result.stage === 'hot' ? { hot: true } : {}),
    },
  }).catch(() => {});

  if (result.shouldEscalate) {
    const newStatus = result.isUnsub ? 'unsubscribed' : 'hot';
    await prisma.lead.update({ where: { id: lead.id }, data: { status: newStatus } }).catch(() => {});

    await prisma.activity.create({
      data: {
        color: result.isUnsub ? 'amber' : 'red',
        msg:   result.isUnsub
          ? `${lead.name} opted out — AI stopped outreach`
          : `🔥 ${lead.name} at ${lead.company || 'unknown'} is HOT — needs human`,
        tag: 'AI Reply',
      },
    }).catch(() => {});
    return;
  }

  if (!result.shouldSend || !result.response) return;

  // Assist mode: save draft, don't send
  if (config.mode === 'assist') {
    await prisma.reply.update({ where: { id: replyId }, data: { aiDraft: result.response } }).catch(() => {});
    return;
  }

  // Autopilot: send, but respect send window
  if (!isWithinSendWindow()) {
    await prisma.reply.update({ where: { id: replyId }, data: { aiDraft: result.response } }).catch(() => {});
    return;
  }

  const channel = (reply.channel || '').toLowerCase();
  try {
    if (channel === 'whatsapp' || channel === 'wa') {
      if (!lead.phone) return;
      await sendMessage({ phone: lead.phone, message: result.response });
    } else if (channel === 'email') {
      if (!lead.email) return;
      const campConfig = campaign?.config || {};
      const subject = `Re: your enquiry`;
      if (campConfig.smtp?.user && campConfig.smtp?.pass) {
        await sendViaSMTP({ smtpConfig: campConfig.smtp, to: lead.email, subject, body: result.response, fromName: campConfig.fromName || biz?.name || 'Team', replyTo: campConfig.replyTo });
      } else {
        await sendEmail({ to: lead.email, subject, body: result.response, fromName: campConfig.fromName || biz?.name || 'Team', fromEmail: campConfig.fromEmail || 'outreach@kboos.app', replyTo: campConfig.replyTo });
      }
    }

    await prisma.activity.create({
      data: {
        color: 'blue',
        msg:   `AI replied to ${lead.name} via ${reply.channel} (${result.stage})`,
        tag:   'AI Reply',
      },
    }).catch(() => {});
  } catch (err) {
    console.error('[AutoReply] Send error:', err.message);
  }
}
