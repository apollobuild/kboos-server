import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { sendMessage } from '../services/wati.js';
import { getApiKey } from '../services/apiKeys.js';
import { logClaude } from '../services/costLogger.js';

const router = Router();
const prisma = new PrismaClient();

// POST /webhooks/sendgrid
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

// POST /webhooks/wati
router.post('/wati', async (req, res) => {
  try {
    const event = req.body;
    const rawPhone = event.waId || event.phone || event.from || '';
    if (!rawPhone) return res.sendStatus(200);

    const digits = rawPhone.replace(/\D/g, '').slice(-9);
    const normalizedPhone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone.replace(/\D/g, '')}`;
    const eventType = event.eventType || event.type || '';
    const incomingMsg = event.text || event.body || '';

    // Handle regular campaign leads
    const lead = await prisma.lead.findFirst({
      where: { phone: { contains: digits } },
      select: { id: true, status: true, name: true, company: true },
    }).catch(() => null);

    if (lead) {
      if (eventType === 'optOut' || eventType === 'opt_out' || event.isOptOut) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'unsubscribed' } }).catch(() => {});
        await prisma.reply.create({
          data: { leadId: lead.id, name: lead.name, company: lead.company, channel: 'whatsapp', msg: 'Opted out of WhatsApp', unsub: true, status: 'read' },
        }).catch(() => {});
      }
      if (eventType === 'message' && incomingMsg) {
        await prisma.reply.create({
          data: { leadId: lead.id, name: lead.name, company: lead.company, channel: 'whatsapp', msg: incomingMsg, status: 'unread' },
        }).catch(() => {});
        if (!['replied', 'hot', 'meeting_booked', 'unsubscribed'].includes(lead.status)) {
          await prisma.lead.update({ where: { id: lead.id }, data: { status: 'replied' } }).catch(() => {});
        }
      }
    }

    // Handle demo prospects — AI booking bot
    if (eventType === 'message' && incomingMsg) {
      const prospect = await prisma.demoProspect.findUnique({ where: { phone: normalizedPhone } }).catch(() => null);
      if (prospect) await handleDemoReply({ prospect, incomingMsg });
    }
  } catch { /* always 200 */ }
  res.sendStatus(200);
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
    console.error('Demo reply bot error:', e.message);
  }
}

export default router;
