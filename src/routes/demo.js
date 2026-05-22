import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { PrismaClient } from '@prisma/client';
import { makeCall } from '../services/vapi.js';
import { sendEmail } from '../services/sendgrid.js';
import { sendMessage } from '../services/wati.js';
import { getApiKey } from '../services/apiKeys.js';
import { logClaude } from '../services/costLogger.js';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const prisma = new PrismaClient();

// In-memory rate limit: phone → { usedAt, preview }
const prospectCache = new Map();
const RATE_MS = 24 * 60 * 60 * 1000;

function parseJSON(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(cleaned);
}

// GET /demo/stats — real numbers for proof ticker (public)
router.get('/stats', async (req, res, next) => {
  try {
    const [bizCount, msgCount, industries] = await Promise.all([
      prisma.business.count(),
      prisma.campaignAction.count({ where: { status: 'sent' } }),
      prisma.business.findMany({ select: { industry: true }, distinct: ['industry'] }),
    ]);
    res.json({
      businesses: bizCount,
      messagesSent: msgCount,
      industries: industries.length,
    });
  } catch (e) { next(e); }
});

// POST /demo/generate — internal, authenticated live demo (KBOOS team)
router.post('/generate', requireAuth, async (req, res, next) => {
  try {
    const { name, company, industry, title, lang, tone, city, currentMethod, challenge, monthlyGoal } = req.body;
    const key = await getApiKey('claude');
    if (!key) return res.status(400).json({ error: 'Claude API key not configured. Go to Settings → API Keys.' });

    const client = new Anthropic({ apiKey: key });
    const langLabel = lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English';

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

    const kboosOffer = `
KBOOS CORE OFFER (this is what you're selling — use Hormozi's Value Equation throughout):
- Dream Outcome: ${monthlyGoal || 'consistent new clients every month'} — without cold calling, without referral dependency, without hiring more staff
- Proof: 200+ campaigns run across Malaysia, average 23% reply rate — 3x industry average
- Time to First Result: First replies within 48 hours of campaign launch
- Effort Removed: KOBIS builds the prospect list, AI writes every message, handles every follow-up, sends WhatsApp + email + AI voice call automatically — the client just closes the deals that land in their inbox
- Risk Reversal: If they don't see replies in the first 7 days, we rebuild the campaign completely — free, no questions asked
- Guarantee: The first deal they close through KBOOS pays for the entire year's subscription

INDUSTRY CONTEXT: This prospect is in ${industry} in Malaysia. Use their industry language — NOT generic "meetings" or "leads" language. If they sell cars, talk about selling cars. If they do catering, talk about bookings. Make the copy feel like you've run campaigns for their exact type of business before.`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are an elite B2B copywriter for KOBIS, a Malaysian AI outreach automation company. You apply Alex Hormozi's $100M Offers framework. Your copy creates the "this offer is too good to miss" feeling. Return only valid JSON.`,
      messages: [{
        role: 'user',
        content: `Write personalised outreach that sells KBOOS to this specific prospect. Make it so good they feel it would be a mistake to say no.

PROSPECT:
Name: ${name}
Title: ${title || 'Decision Maker'}
Company: ${company}
Industry: ${industry}
City: ${city || 'Malaysia'}
Language: ${langLabel}

THEIR SITUATION (make the copy painfully specific to this):
${prospectSituation}

${kboosOffer}

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

    logClaude({ model: 'claude-sonnet-4-6', inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'live_demo' });
    res.json(parseJSON(msg.content[0].text));
  } catch (e) { next(e); }
});

// POST /demo/fire — authenticated, send to one or all channels
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
        const call = await makeCall({ phone, leadName: name, bizName: 'KOBIS Berhad', campaignScript: content.voiceScript });
        results.voice = { ok: true, callId: call.id };
      } catch (e) { results.voice = { ok: false, error: e.message }; }
    }

    await prisma.activity.create({
      data: { color: 'purple', msg: `Live Demo: outreach fired to ${name} at ${company} (${channels.join(', ')})`, tag: 'Demo' },
    }).catch(() => {});

    res.json({ ok: true, results });
  } catch (e) { next(e); }
});

// ─── Self-serve prospect demo (public, rate-limited) ─────────────────────────

// POST /demo/prospect — generate preview for prospect (no login required)
router.post('/prospect', async (req, res, next) => {
  try {
    const { name, company, industry, city, title, phone, email, lang, challenge } = req.body;
    if (!name || !company || !phone || !email) return res.status(400).json({ error: 'Name, company, phone and email are required.' });

    // Rate limit: 1 demo per phone number per 24 hours
    const existing = prospectCache.get(phone);
    if (existing && Date.now() - existing.usedAt < RATE_MS) {
      return res.status(429).json({ error: 'One demo per phone number per 24 hours. See you tomorrow!', cached: existing.preview });
    }

    const key = await getApiKey('claude');
    if (!key) return res.status(400).json({ error: 'System is temporarily unavailable. Please try again later.' });

    const client = new Anthropic({ apiKey: key });
    const langLabel = lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English';

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1600,
      system: `You are an elite B2B copywriter for KOBIS, a Malaysian AI outreach automation company. Write short, punchy outreach that makes prospects feel genuinely excited. Return only valid JSON.`,
      messages: [{
        role: 'user',
        content: `Generate personalised outreach for a KBOOS prospect demo. Write as if KOBIS is reaching out to help THEIR business get more clients.

PROSPECT:
Name: ${name}
${title ? `Role: ${title}` : ''}
Company: ${company}
Industry: ${industry || 'Business Services'}
${city ? `City: ${city}, Malaysia` : 'Location: Malaysia'}
Language: ${langLabel}
${challenge ? `Challenge: ${challenge}` : ''}

Write copy that:
1. Opens with their dream outcome (more clients, more revenue)
2. Names their pain (referral dependency, manual outreach, inconsistent pipeline)
3. Shows KBOOS as the bridge — AI handles the outreach, they close the deals
4. Includes a proof point (23% avg reply rate, 3× industry avg, first replies in 48 hours)
5. Ends with a no-risk CTA (7-day money-back)
6. Match their language (${langLabel})

Return JSON:
{
  "whatsapp": "WhatsApp message under 80 words — warm, conversational, one soft question at end",
  "emailSubject": "Email subject under 7 words",
  "emailBody": "Email body 100-130 words — professional but personal, ends with P.S. line",
  "voiceScript": "Full AI voice agent system prompt 150-200 words — agent introduces as KOBIS AI, presents the KBOOS offer for their specific industry, handles 3 common objections (busy/not interested/too expensive), goal is to book a 15-min discovery call, ends by offering to connect to a human specialist"
}`
      }]
    });

    logClaude({ model: 'claude-haiku-4-5-20251001', inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'prospect_demo' });

    const preview = parseJSON(msg.content[0].text);
    prospectCache.set(phone, { usedAt: Date.now(), preview });

    // Save prospect to DB for AI reply bot tracking
    await prisma.demoProspect.upsert({
      where: { phone },
      create: { name, company, industry: industry || '', phone, email, lang: lang || 'EN',
        waMsg: preview.whatsapp, emailSubject: preview.emailSubject,
        emailBody: preview.emailBody, voiceScript: preview.voiceScript || '' },
      update: { name, company, industry: industry || '', email, lang: lang || 'EN',
        waMsg: preview.whatsapp, emailSubject: preview.emailSubject,
        emailBody: preview.emailBody, voiceScript: preview.voiceScript || '',
        convoHistory: [], updatedAt: new Date(),
      },
    }).catch(() => {});

    res.json({ ok: true, preview });
  } catch (e) { next(e); }
});

// POST /demo/prospect/send — send WA + email + AI voice call to prospect
router.post('/prospect/send', async (req, res, next) => {
  try {
    const { name, company, phone, email, preview, channels } = req.body;
    if (!phone || !email || !preview) return res.status(400).json({ error: 'Missing required fields.' });

    const record = prospectCache.get(phone);
    if (!record) return res.status(400).json({ error: 'Please generate your preview first.' });

    const results = {};

    if (!channels || channels.includes('whatsapp')) {
      try {
        await sendMessage({ phone, message: preview.whatsapp });
        results.whatsapp = { ok: true };
      } catch (e) { results.whatsapp = { ok: false, error: e.message }; }
    }

    if (!channels || channels.includes('email')) {
      try {
        await sendEmail({ to: email, subject: preview.emailSubject, body: preview.emailBody });
        results.email = { ok: true };
      } catch (e) { results.email = { ok: false, error: e.message }; }
    }

    // AI voice call — fires after WA + email so prospect sees messages first
    if (!channels || channels.includes('voice')) {
      try {
        const script = preview.voiceScript || `You are a friendly AI representative for KOBIS, a Malaysian AI outreach company. Introduce yourself, mention you just sent ${name} a WhatsApp and email about helping ${company} get more clients, and aim to book a 15-minute discovery call.`;
        const call = await makeCall({ phone, leadName: name, bizName: 'KOBIS Berhad', campaignScript: script });
        results.voice = { ok: true, callId: call?.id };
      } catch (e) { results.voice = { ok: false, error: e.message }; }
    }

    await prisma.activity.create({
      data: { color: 'green', msg: `Self-serve demo: ${name} at ${company} — WA + email + AI call fired`, tag: 'Demo' },
    }).catch(() => {});

    res.json({ ok: true, results });
  } catch (e) { next(e); }
});

export default router;
