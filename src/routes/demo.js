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
    const { name, company, industry, title, lang, tone } = req.body;
    const key = await getApiKey('claude');
    if (!key) return res.status(400).json({ error: 'Claude API key not configured. Go to Settings → API Keys.' });

    const client = new Anthropic({ apiKey: key });
    const langLabel = lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English';
    const toneLabel = tone || 'Professional';

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: 'You are a B2B outreach expert for KOBIS, a Malaysian outreach automation company. Return only valid JSON.',
      messages: [{
        role: 'user',
        content: `Generate personalised outreach for this prospect on behalf of KOBIS Berhad (an AI-powered B2B outreach platform):

Prospect: ${name}
Title: ${title}
Company: ${company}
Industry: ${industry}
Language: ${langLabel}
Tone: ${toneLabel}

KOBIS helps Malaysian businesses automate personalised outreach via email, WhatsApp and AI voice calls.

Return JSON with exactly these keys:
{
  "emailSubject": "compelling subject line, personalised",
  "emailBody": "150 word max email body, personalised to their industry and role, natural not salesy",
  "whatsapp": "WhatsApp message under 80 words, casual but professional, mention their name and company",
  "voiceScript": "30-second voice call script, natural speech, mentions prospect name and company, asks if they have 2 minutes"
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
