import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './apiKeys.js';

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

export async function generateBrief({ name, industry, service, audience, usps, tone, lang }) {
  const client = await getClient();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are an expert B2B outreach strategist for Malaysian SMEs. Return only valid JSON.',
    messages: [{
      role: 'user',
      content: `Generate outreach copy for ${name}, a ${industry} company in Malaysia.
Service: ${service}
Target Audience: ${audience}
Unique Selling Points: ${usps}
Tone: ${tone}
Language: ${lang}

Return JSON with exactly these keys:
{
  "email": "complete cold email (subject + body, under 150 words)",
  "whatsapp": "WhatsApp message under 80 words, conversational",
  "voice": "30-second voice script, natural speech",
  "scoring": "criteria for scoring leads: title keywords, company types, engagement signals"
}`
    }]
  });
  return parseJSON(msg.content[0].text);
}

export async function generateEmail({ bizName, campaignName, prompt, lead }) {
  const client = await getClient();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: 'You are a B2B cold email expert for Malaysian companies. Return only valid JSON.',
    messages: [{
      role: 'user',
      content: `Write a cold email for ${bizName} — campaign: ${campaignName}.
Lead: ${lead.name} at ${lead.company}, ${lead.title}
Language: ${lead.lang === 'BM' ? 'Bahasa Malaysia' : 'English'}
Style guidance: ${prompt}

Return JSON: { "subject": "...", "body": "..." }
Body under 130 words. Natural tone, not salesy.`
    }]
  });
  return parseJSON(msg.content[0].text);
}

export async function suggestReply({ message, senderName, company, channel, isHot, isUnsub }) {
  const client = await getClient();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
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
