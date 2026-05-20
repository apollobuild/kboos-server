import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './apiKeys.js';
import { logClaude } from './costLogger.js';

async function getClient() {
  const key = await getApiKey('claude');
  if (!key) throw Object.assign(new Error('Claude API key not configured'), { status: 400 });
  return new Anthropic({ apiKey: key });
}

function parseJSON(text) {
  // Strip markdown code fences if Claude wraps the response
  const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(cleaned);
}

export async function generateBrief({ name, industry, website, service, audience, usps, tone, lang }) {
  const client = await getClient();
  const model = 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: 'You are an expert B2B outreach strategist for Malaysian SMEs. Return only valid JSON.',
    messages: [{
      role: 'user',
      content: `Generate outreach copy for ${name}, a ${industry} company in Malaysia.
${website ? `Website: ${website}` : ''}
Service: ${service}
Target Audience: ${audience}
Unique Selling Points: ${usps}
Tone: ${tone}
Language: ${lang}

Return JSON with exactly these 4 keys. All values must be plain strings (no nested objects):
{
  "email": "Subject: [subject line]\\n\\n[full email body under 150 words]",
  "whatsapp": "WhatsApp message under 80 words, conversational tone",
  "voice": "30-second voice script written as natural speech",
  "scoring": "bullet list of lead scoring criteria: title keywords, company types, engagement signals"
}`
    }]
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_brief' });
  return parseJSON(msg.content[0].text);
}

export async function generateEmail({ bizName, campaignName, prompt, lead }) {
  const client = await getClient();
  const lang = lead.lang === 'MS' || lead.lang === 'BM' ? 'Bahasa Malaysia'
    : lead.lang === 'ZH' ? 'Mandarin Chinese'
    : 'English';
  const emailModel = 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model: emailModel,
    max_tokens: 1024,
    system: `You are a cold email expert specialising in Malaysian B2B outreach. You write emails that get replies, not just opens.

Non-negotiable rules:
- Subject: under 7 words. Never starts with the company name or "I". Must use one of these formulas: curiosity gap ("Still losing leads to competitors in Johor?"), hyper-specific stat ("3 ${lead.title || 'managers'} in ${lead.company || 'your industry'} replied this week"), social proof ("How [Similar Co] added 40% pipeline"), or direct question ("Quick question about {{company}}")
- Body first line: NEVER starts with "I" — open with the prospect, their company, or a relevant observation
- Maximum 5 sentences before the CTA
- One CTA only — never give the reader multiple options
- Always end with a P.S. line — it gets read first and lifts reply rate significantly
- Banned words and phrases: synergy, leverage, solutions, world-class, "I hope this email finds you well", "please find attached", "I wanted to reach out", "touching base"
- Reference local Malaysian context where natural: city names, challenges like talent shortage, SST compliance, rising logistics costs, digital transformation pressure
- Match Malaysian relationship-first culture: warm tone, not aggressive American-style sales

Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `Write a cold email for ${bizName} — campaign: ${campaignName}.
Lead: ${lead.name} at ${lead.company}, ${lead.title}
Language: ${lang}
Style guidance: ${prompt}

Return JSON with exactly these keys:
{
  "subjects": ["subject variant 1", "subject variant 2", "subject variant 3"],
  "body": "full email body under 130 words, keeping {{variables}} intact, ending with a P.S. line"
}`
    }]
  });
  logClaude({ model: emailModel, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_email' });
  const parsed = parseJSON(msg.content[0].text);
  return { ...parsed, subject: Array.isArray(parsed.subjects) ? parsed.subjects[0] : parsed.subject || '' };
}

export async function suggestReply({ message, senderName, company, channel, isHot, isUnsub }) {
  const client = await getClient();
  const replyModel = 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model: replyModel,
    max_tokens: 256,
    system: 'You handle B2B outreach replies for a Malaysian company. Be concise and professional.',
    messages: [{
      role: 'user',
      content: `Reply to this ${channel} message from ${senderName} at ${company}:
"${message}"
${isUnsub ? 'They want to unsubscribe — acknowledge and confirm removal.' : ''}
${isHot ? 'They seem very interested — schedule a meeting.' : ''}

Write a short, natural reply in the same language as their message. Return just the reply text, no JSON.`
    }]
  });
  logClaude({ model: replyModel, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'suggest_reply' });
  return msg.content[0].text.trim();
}

export async function testConnection(apiKey) {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }]
  });
  return !!msg.content[0].text;
}
