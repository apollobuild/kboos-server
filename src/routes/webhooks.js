import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import { sendMessage } from '../services/wati.js';
import { getApiKey } from '../services/apiKeys.js';
import { logClaude } from '../services/costLogger.js';
import { enqueue } from '../services/queue.js';

const router = Router();
const prisma = new PrismaClient();
const upload = multer();

function verifySecret(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured — allow all (dev mode)
  return req.query.secret === secret || req.headers['x-webhook-secret'] === secret;
}

// ─── POST /webhooks/sendgrid — SendGrid event webhook (opens, bounces, unsubscribes) ───
router.post('/sendgrid', async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      const email = event.email;
      if (!email) continue;
      const lead = await prisma.lead.findFirst({ where: { email }, select: { id: true, status: true } }).catch(() => null);
      if (!lead) continue;

      if (event.event === 'open' && !['replied', 'hot', 'meeting_booked'].includes(lead.status)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'opened' } }).catch(() => {});
        await prisma.campaignAction.updateMany({
          where: { leadId: lead.id, type: 'email', status: 'sent', openedAt: null },
          data: { openedAt: new Date(), status: 'opened' },
        }).catch(() => {});
      }
      if (['bounce', 'dropped'].includes(event.event)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'bounced' } }).catch(() => {});
      }
      if (['unsubscribe', 'group_unsubscribe'].includes(event.event)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'unsubscribed' } }).catch(() => {});
        await prisma.reply.create({
          data: { leadId: lead.id, name: email, company: '', channel: 'email', msg: 'Unsubscribed via email', unsub: true, status: 'read' },
        }).catch(() => {});
      }
    }
  } catch { /* always 200 */ }
  res.sendStatus(200);
});

// ─── POST /webhooks/sendgrid-inbound — SendGrid Inbound Parse (actual email replies) ───
router.post('/sendgrid-inbound', upload.none(), async (req, res) => {
  res.sendStatus(200); // always ack first
  if (!verifySecret(req)) return;

  try {
    const from = req.body.from || '';
    const subject = req.body.subject || '';
    const text = (req.body.text || req.body.html || '').trim();
    if (!from || !text) return;

    // Extract email address from "Name <email@domain.com>" format
    const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
    const senderEmail = emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase().trim();
    const senderName = from.replace(/<[^>]+>/, '').trim() || senderEmail;

    const lead = await prisma.lead.findFirst({
      where: { email: senderEmail },
      select: { id: true, status: true, name: true, company: true, campaignId: true, bizId: true },
    }).catch(() => null);

    if (!lead) return;

    // Strip quoted reply history — keep only the new content
    const cleanText = text.split(/\n[-_]{3,}|\nOn .+ wrote:/)[0].trim();
    const msgBody = cleanText.substring(0, 2000);

    const isUnsub = /unsubscribe|opt.?out|remove me|stop emailing/i.test(msgBody);

    // Append to existing open Reply thread for this lead, or create new
    const existing = await prisma.reply.findFirst({
      where: { leadId: lead.id, channel: 'email', status: { in: ['unread', 'read'] } },
      orderBy: { createdAt: 'desc' },
    }).catch(() => null);

    const threadEntry = { role: 'lead', msg: msgBody, subject, ts: new Date().toISOString() };

    if (existing) {
      const thread = Array.isArray(existing.thread) ? existing.thread : [];
      await prisma.reply.update({
        where: { id: existing.id },
        data: {
          msg: msgBody,
          status: 'unread',
          unsub: isUnsub || existing.unsub,
          thread: [...thread, threadEntry],
        },
      }).catch(() => {});
    } else {
      await prisma.reply.create({
        data: {
          leadId: lead.id,
          bizId: lead.bizId,
          name: lead.name || senderName,
          company: lead.company || '',
          channel: 'email',
          msg: msgBody,
          status: 'unread',
          unsub: isUnsub,
          thread: [threadEntry],
        },
      }).catch(() => {});
    }

    if (!['replied', 'hot', 'meeting_booked', 'unsubscribed'].includes(lead.status)) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: isUnsub ? 'unsubscribed' : 'replied' },
      }).catch(() => {});
    }

    await prisma.activity.create({
      data: {
        color: isUnsub ? 'amber' : 'blue',
        msg: `${lead.name || senderEmail} replied via email${subject ? ` — "${subject.substring(0, 40)}"` : ''}`,
        tag: 'Inbox',
      },
    }).catch(() => {});

    // Trigger AI auto-reply
    const savedReply2 = existing || await prisma.reply.findFirst({ where: { leadId: lead.id, channel: 'email' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
    if (savedReply2) enqueue('auto-reply', { replyId: savedReply2.id, leadId: lead.id }).catch(() => {});

  } catch (e) {
    console.error('[Webhook] sendgrid-inbound error:', e.message);
  }
});

// ─── POST /webhooks/wati — WATI inbound WhatsApp messages ───
router.post('/wati', async (req, res) => {
  res.sendStatus(200); // always ack first
  if (!verifySecret(req)) return;

  try {
    const event = req.body;
    const rawPhone = event.waId || event.phone || event.from || '';
    if (!rawPhone) return;

    const digits = rawPhone.replace(/\D/g, '').slice(-9);
    const normalizedPhone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone.replace(/\D/g, '')}`;
    const eventType = event.eventType || event.type || '';
    const incomingMsg = (event.text || event.body || '').trim();

    // Handle campaign leads
    const lead = await prisma.lead.findFirst({
      where: { phone: { contains: digits } },
      select: { id: true, status: true, name: true, company: true, bizId: true },
    }).catch(() => null);

    if (lead) {
      if (eventType === 'optOut' || eventType === 'opt_out' || event.isOptOut) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'unsubscribed' } }).catch(() => {});
        await prisma.reply.create({
          data: { leadId: lead.id, bizId: lead.bizId, name: lead.name, company: lead.company, channel: 'whatsapp', msg: 'Opted out of WhatsApp', unsub: true, status: 'read' },
        }).catch(() => {});
        await prisma.activity.create({
          data: { color: 'amber', msg: `${lead.name} opted out of WhatsApp`, tag: 'Inbox' },
        }).catch(() => {});
      }

      if (eventType === 'message' && incomingMsg) {
        const isUnsub = /unsubscribe|opt.?out|stop|berhenti/i.test(incomingMsg);
        const threadEntry = { role: 'lead', msg: incomingMsg, ts: new Date().toISOString() };

        // Append to existing open WA thread for this lead, or create new
        const existing = await prisma.reply.findFirst({
          where: { leadId: lead.id, channel: 'whatsapp', status: { in: ['unread', 'read'] } },
          orderBy: { createdAt: 'desc' },
        }).catch(() => null);

        if (existing) {
          const thread = Array.isArray(existing.thread) ? existing.thread : [];
          await prisma.reply.update({
            where: { id: existing.id },
            data: { msg: incomingMsg, status: 'unread', thread: [...thread, threadEntry] },
          }).catch(() => {});
        } else {
          await prisma.reply.create({
            data: {
              leadId: lead.id,
              bizId: lead.bizId,
              name: lead.name,
              company: lead.company,
              channel: 'whatsapp',
              msg: incomingMsg,
              status: 'unread',
              unsub: isUnsub,
              thread: [threadEntry],
            },
          }).catch(() => {});
        }

        if (!['replied', 'hot', 'meeting_booked', 'unsubscribed'].includes(lead.status)) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { status: isUnsub ? 'unsubscribed' : 'replied' },
          }).catch(() => {});
        }

        await prisma.activity.create({
          data: {
            color: isUnsub ? 'amber' : 'green',
            msg: `${lead.name} replied on WhatsApp — "${incomingMsg.substring(0, 60)}${incomingMsg.length > 60 ? '…' : ''}"`,
            tag: 'Inbox',
          },
        }).catch(() => {});

        // Trigger AI auto-reply
        const savedReply = existing || await prisma.reply.findFirst({ where: { leadId: lead.id, channel: 'whatsapp' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
        if (savedReply) enqueue('auto-reply', { replyId: savedReply.id, leadId: lead.id }).catch(() => {});
      }
    }

    // Handle demo prospects — AI booking bot (unchanged)
    if (eventType === 'message' && incomingMsg) {
      const prospect = await prisma.demoProspect.findUnique({ where: { phone: normalizedPhone } }).catch(() => null);
      if (prospect) await handleDemoReply({ prospect, incomingMsg });
    }
  } catch (e) {
    console.error('[Webhook] WATI error:', e.message);
  }
});

async function handleDemoReply({ prospect, incomingMsg }) {
  try {
    const key = await getApiKey('claude');
    if (!key) return;

    const history = Array.isArray(prospect.convoHistory) ? prospect.convoHistory : [];
    history.push({ role: 'user', content: incomingMsg, ts: new Date().toISOString() });

    const langLabel = prospect.lang === 'MS' ? 'Bahasa Malaysia' : prospect.lang === 'ZH' ? 'Mandarin Chinese' : 'English';
    const recentConvo = history.slice(-8).map(h =>
      `${h.role === 'user' ? prospect.name : 'KOBIS AI'}: ${h.content}`
    ).join('\n');

    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      system: `You are KOBIS's AI sales assistant replying on WhatsApp. Goal: book a 15-minute discovery call.
Rules: Be warm and natural. Never pushy. Keep replies under 60 words. Match their language (${langLabel}).
If interested → suggest a specific time slot.
If asking questions → answer briefly, then invite them to a quick call.
If not interested → thank them graciously and wish them well. Do not follow up.`,
      messages: [{
        role: 'user',
        content: `Prospect: ${prospect.name} at ${prospect.company} (${prospect.industry})
First message we sent: ${prospect.waMsg}

Conversation so far:
${recentConvo}

Write KOBIS AI's next reply. Under 60 words. Natural and human.`,
      }],
    });

    const reply = msg.content[0].text.trim();
    logClaude({ model: 'claude-haiku-4-5-20251001', inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'demo_reply_bot' });

    history.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
    await prisma.demoProspect.update({
      where: { phone: prospect.phone },
      data: { convoHistory: history, updatedAt: new Date() },
    }).catch(() => {});

    await sendMessage({ phone: prospect.phone, message: reply });

    await prisma.activity.create({
      data: { color: 'blue', msg: `AI booking bot replied to ${prospect.name} at ${prospect.company}`, tag: 'AI Bot' },
    }).catch(() => {});
  } catch (e) {
    console.error('[Webhook] Demo reply bot error:', e.message);
  }
}

// POST /webhooks/openwa — incoming WhatsApp message via OpenWA
router.post('/openwa', async (req, res) => {
  try {
    res.sendStatus(200); // ack fast
    const { body: msgBody, from, sessionName } = req.body;
    if (!msgBody || !from) return;

    const phone = from.replace('@c.us', '').replace('@s.whatsapp.net', '');
    const text = typeof msgBody === 'string' ? msgBody : msgBody?.text || '';

    // Find matching lead
    const lead = await prisma.lead.findFirst({
      where: { phone: { contains: phone.slice(-8) } },
      select: { id: true, name: true, company: true, tenantId: true },
    }).catch(() => null);

    const tenantId = lead?.tenantId || 'default';

    // Check for stop words → suppress lead and update health score
    const { isStopWord } = await import('../services/openwa.js');
    if (isStopWord(text)) {
      if (lead) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'unsubscribed' } }).catch(() => {});
      }
      // Mark opted out in any WA campaigns
      const campaigns = await prisma.wAConnectCampaign.findMany({ where: { tenantId } });
      for (const c of campaigns) {
        const statuses = Array.isArray(c.leadStatuses) ? c.leadStatuses : [];
        const idx = statuses.findIndex(s => s.phone?.includes(phone.slice(-8)));
        if (idx >= 0) {
          statuses[idx].optedOut = true;
          await prisma.wAConnectCampaign.update({ where: { id: c.id }, data: { leadStatuses: statuses } }).catch(() => {});
        }
      }
      // Update session health
      const session = await prisma.openWASession.findFirst({ where: { sessionName: sessionName || '' } }).catch(() => null);
      if (session) await prisma.openWASession.update({ where: { id: session.id }, data: { optOutCount: { increment: 1 }, healthScore: { decrement: 5 } } }).catch(() => {});
    }

    // Create reply in unified inbox
    await prisma.reply.create({
      data: {
        tenantId,
        leadId: lead?.id || null,
        name: lead?.name || phone,
        company: lead?.company || '',
        channel: 'whatsapp_connect',
        msg: text,
        status: 'unread',
        hot: false,
        unsub: isStopWord(text),
        bizId: '',
      },
    }).catch(() => {});

  } catch (err) {
    console.error('[OpenWA webhook]', err.message);
  }
});

export default router;
