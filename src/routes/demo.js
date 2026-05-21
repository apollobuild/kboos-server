import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { PrismaClient } from '@prisma/client';
import { makeCall } from '../services/vapi.js';
import { sendEmail } from '../services/sendgrid.js';
import { sendMessage } from '../services/wati.js';
import { getApiKey } from '../services/apiKeys.js';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const prisma = new PrismaClient();

function parseJSON(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(cleaned);
}

// POST /demo/generate — generate personalised content for all 3 channels
router.post('/generate', requireAuth, async (req, res, next) => {
  try {
    const { name, company, industry, title, lang, tone, city, currentMethod, challenge, monthlyGoal } = req.body;
    const key = await getApiKey('claude');
    if (!key) return res.status(400).json({ error: 'Claude API key not configured. Go to Settings → API Keys.' });

    const client = new Anthropic({ apiKey: key });
    const langLabel = lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English';
    const toneLabel = tone || 'Professional';

    const methodLabels = {
      referral: 'relies on referrals only — no active outreach',
      coldcall: 'does manual cold calling',
      ads: 'runs social media / Google ads',
      network: 'attends networking events',
      nothing: 'is not actively prospecting — struggling to find clients',
    };
    const prospectSituation = [
      `Current client acquisition method: ${methodLabels[currentMethod] || currentMethod}`,
      challenge ? `Their biggest challenge: ${challenge}` : null,
      monthlyGoal ? `Their dream outcome (Hormozi): ${monthlyGoal} — use this exact outcome as the promise in all copy` : null,
      city ? `Based in: ${city}` : null,
    ].filter(Boolean).join('\n');

    // Load active templates if they exist — use them as base for personalisation
    const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } }).catch(() => null);
    const activeEmail = settings?.promptTemplates?.find(t => t.active);
    const activeWA    = settings?.waTemplates?.find(t => t.active);
    const activeVoice = settings?.voiceTemplates?.find(t => t.active);

    const emailInstruction = activeEmail
      ? `Personalise this email template for the prospect. Keep the structure and offer — only swap in their name, company, industry, role and city naturally:\n\nSubject: ${activeEmail.subject || ''}\n\n${activeEmail.body || activeEmail.content || ''}`
      : `Write a compelling cold email: subject under 7 words (curiosity/stat/proof formula), body under 140 words, open with their situation not yours, one soft CTA, end with P.S. line.`;

    const waInstruction = activeWA
      ? `Personalise this WhatsApp template for the prospect. Keep the offer and tone — swap in their details:\n\n${activeWA.body || activeWA.content || ''}`
      : `Write a WhatsApp message under 90 words: start with their name, one curiosity hook, end with one soft question. No pitching.`;

    const voiceInstruction = activeVoice
      ? `This is the voice agent system prompt to use. Personalise any placeholders for this prospect:\n\n${activeVoice.body || activeVoice.content || ''}`
      : `Write a FULL voice agent behavioral system prompt (not a script). The agent must sound human, get permission to talk, present the offer naturally, handle common objections (busy/not interested/who are you/send email), re-engage off-topic conversations, and close with booking a call or offering to connect to the specialist. Include all objection handlers and rules of behavior. 300-400 words.`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
      system: 'You are a B2B outreach expert for KOBIS, a Malaysian outreach automation company. Return only valid JSON.',
      messages: [{
        role: 'user',
        content: `Generate personalised outreach for this prospect. This is for KBOOS — an AI-powered outreach automation system that helps Malaysian businesses get more qualified meetings on autopilot. The copy must sell KBOOS to this specific prospect by speaking directly to their situation.

Prospect: ${name}
Title: ${title || 'Decision Maker'}
Company: ${company}
Industry: ${industry}
Language: ${langLabel}
Tone: ${toneLabel}

PROSPECT'S CURRENT SITUATION (use this to make the copy painfully relevant):
${prospectSituation}

Apply Alex Hormozi's Value Equation: Value = (Dream Outcome × Perceived Likelihood) / (Time Delay × Effort).
The email, WhatsApp, and voice agent MUST:
- Open with their dream outcome (${monthlyGoal || 'their goal'}) as the hook — not KBOOS features
- Frame their current method as the bottleneck limiting them from that outcome
- Connect to their specific challenge if provided
- Show KBOOS as the bridge: "you could [dream outcome] without [current struggle] starting this month"
- Sound like we already know their business — not a generic pitch
- NEVER say "book more meetings" if their goal is selling cars, landing catering jobs, enrolling students, etc. — match their industry language exactly

EMAIL INSTRUCTIONS: ${emailInstruction}

WHATSAPP INSTRUCTIONS: ${waInstruction}

VOICE AGENT INSTRUCTIONS: ${voiceInstruction}

Return JSON with exactly these keys:
{
  "emailSubject": "...",
  "emailBody": "...",
  "whatsapp": "...",
  "voiceScript": "..."
}`
      }]
    });

    res.json(parseJSON(msg.content[0].text));
  } catch (e) { next(e); }
});

// POST /demo/fire — send to one or all channels directly (no DB lead needed)
router.post('/fire', requireAuth, async (req, res, next) => {
  try {
    const { name, phone, email, company, channels, content } = req.body;
    const results = {};

    if (channels.includes('email') && email) {
      try {
        await sendEmail({ to: email, subject: content.emailSubject, body: content.emailBody });
        results.email = { ok: true };
      } catch (e) { results.email = { ok: false, error: e.message }; }
    }

    if (channels.includes('whatsapp') && phone) {
      try {
        await sendMessage({ phone, message: content.whatsapp });
        results.whatsapp = { ok: true };
      } catch (e) { results.whatsapp = { ok: false, error: e.message }; }
    }

    if (channels.includes('voice') && phone) {
      try {
        const call = await makeCall({
          phone,
          leadName: name,
          bizName: 'KOBIS Berhad',
          campaignScript: content.voiceScript,
        });
        results.voice = { ok: true, callId: call.id };
      } catch (e) { results.voice = { ok: false, error: e.message }; }
    }

    // Log to activity feed
    await prisma.activity.create({
      data: {
        color: 'purple',
        msg: `Live Demo: outreach fired to ${name} at ${company} (${channels.join(', ')})`,
        tag: 'Demo',
      },
    }).catch(() => {});

    res.json({ ok: true, results });
  } catch (e) { next(e); }
});

export default router;
