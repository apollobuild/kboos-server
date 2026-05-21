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

COPY RULES — non-negotiable:
1. Lead with their dream outcome (${monthlyGoal || 'their goal'}) — not KBOOS, not features, not us
2. Name the bottleneck: their current method is why they're not hitting that outcome yet
3. Position KBOOS as the bridge that removes the effort, not just another tool
4. Use their exact industry language — if they sell cars say "sell cars", if they do catering say "catering bookings"
5. Include one specific proof point (reply rates, similar business results, 48-hour guarantee)
6. End with the risk reversal — eliminate all fear of trying it
7. Sound like you already know their market — not a cold pitch

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
