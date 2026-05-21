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

export async function suggestReply({ message, senderName, company, channel, isHot, isUnsub, thread = [], persona = {}, goal = '', bizName = '', stage = 'cold' }) {
  const client = await getClient();
  const model = 'claude-sonnet-4-6';

  const personaName  = persona.name  || 'Amirah';
  const personaRole  = persona.role  || 'Business Development Executive';
  const personaStyle = persona.style || 'manglish'; // formal | casual | manglish

  const styleGuide = personaStyle === 'formal'
    ? 'Write formally. Full sentences. No slang. Professional sign-off.'
    : personaStyle === 'casual'
    ? 'Write casually. Short sentences. Friendly, warm tone. No formal greetings.'
    : 'Write in natural Malaysian Manglish — mix BM and English naturally where it fits. Use "la", "boleh", "kan" sparingly and only when it feels organic. Never sound forced.';

  const stageGuide = {
    cold:        'They just responded for the first time. Build rapport. Ask one curious question. No hard sell.',
    engaged:     'They\'re interested. Make a soft ask — invite them to take one small next step.',
    qualifying:  'They want details. Make a direct ask toward the goal. Offer to make it easy.',
    committed:   'They said yes or seem ready. Confirm the next step and hand off to the team.',
    closed:      'Done. No reply needed.',
  }[stage] || 'Build rapport and move toward the goal.';

  const threadHistory = thread.length > 0
    ? '\n\nConversation so far (oldest first):\n' + thread.slice(-6).map(t =>
        `[${t.role === 'lead' ? senderName : personaName}]: ${t.content}`
      ).join('\n')
    : '';

  const goalContext = goal
    ? `\nYour goal: guide the conversation toward — ${goal}. Always be moving there, never forcing it.`
    : '';

  const unsubInstructions = isUnsub
    ? 'They want to unsubscribe. Acknowledge warmly, confirm removal, wish them well. No further selling.'
    : '';

  const hotInstructions = isHot
    ? 'They are very interested / hot lead. Move quickly to confirm next step. Escalate immediately after this reply.'
    : '';

  const msg = await client.messages.create({
    model,
    max_tokens: 512,
    system: `You are ${personaName}, ${personaRole} at ${bizName || 'our company'} in Malaysia. You are handling a ${channel} conversation with a potential client.

${styleGuide}

Critical rules:
- NEVER say you are an AI, bot, or automated system. If asked, deflect naturally ("haha I'm just quick with replies la").
- NEVER use bullet points or formal "Dear Sir/Madam" greetings in WhatsApp.
- Mirror the lead's language — if they write BM, reply in BM. If they write English, reply English. If Manglish, match it.
- Match their message length — if they sent 1 sentence, reply in 1-2 sentences max.
- Never use banned phrases: "synergy", "solutions", "I hope this email finds you well", "Please find attached".
- End WhatsApp messages conversationally, never with formal sign-offs.
- Be warm, human, and patient.

Return ONLY valid JSON — no markdown, no extra text.`,
    messages: [{
      role: 'user',
      content: `${senderName} from ${company} sent this via ${channel}:
"${message}"
${threadHistory}
${goalContext}
${unsubInstructions}
${hotInstructions}

Current conversation stage: ${stage}
Stage guidance: ${stageGuide}

${unsubInstructions || hotInstructions ? '' : `What stage should this conversation move to? Options: cold, engaged, qualifying, committed, closed.
Should I escalate to the human team? Escalate if: they said yes/want to proceed, they mention pricing, they seem frustrated, or they are clearly ready to commit.`}

Return JSON:
{
  "reply": "the reply message text only",
  "stage": "cold|engaged|qualifying|committed|closed",
  "escalate": false,
  "escalateReason": ""
}`
    }]
  });

  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'smart_reply' });

  try {
    const cleaned = msg.content[0].text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { reply: msg.content[0].text.trim(), stage, escalate: isHot, escalateReason: '' };
  }
}

export async function generateFromOffer({ bizName, industry, service, dreamOutcome, proof, timeToResult, effortRemoved, riskReversal, lang }) {
  const client = await getClient();
  const model = 'claude-sonnet-4-6';
  const langLabel = lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English';

  const msg = await client.messages.create({
    model,
    max_tokens: 2400,
    system: `You are an elite B2B copywriter who applies Alex Hormozi's $100M Offers framework. You write for Malaysian businesses. Language: ${langLabel}. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `Using Hormozi's Value Equation (Value = Dream Outcome × Perceived Likelihood / Time Delay × Effort), generate outreach copy for all 3 channels.

BUSINESS: ${bizName}
INDUSTRY: ${industry}
SERVICE: ${service}

OFFER INPUTS:
- Dream Outcome: ${dreamOutcome}
- Proof/Results: ${proof}
- Time to First Result: ${timeToResult}
- What We Handle (effort removed): ${effortRemoved}
- Risk Reversal: ${riskReversal}

CHANNEL RULES:

EMAIL (emailSubject + emailBody):
- Subject: under 7 words, never start with "I" or company name, use curiosity/stat/social proof formula
- Body: 120-150 words, open with THEIR situation not yours, lead with dream outcome, one proof point, eliminate effort fear, one soft CTA, end with P.S. line
- No banned phrases: "I hope this email finds you well", "I wanted to reach out", "synergy", "solutions"

WHATSAPP (whatsapp):
- Under 90 words, casual but professional, start with their name, open with a curiosity hook about their dream outcome, end with ONE soft question
- No pitching — just open the door

VOICE AGENT SYSTEM PROMPT (voiceSystemPrompt):
Write a FULL behavioral system prompt (400-500 words) for an AI voice agent — NOT a script.
The agent must:
1. Sound 100% human — never confirm or deny being AI unless directly asked
2. Open naturally, get permission to talk (2 minutes)
3. Use the offer to build curiosity, not to pitch
4. Handle these objections naturally with short responses:
   - "I'm busy" → reschedule to specific time
   - "Not interested" → curiosity question about why
   - "Who are you?" / "How did you get my number?" → honest industry-targeting explanation
   - "Send me an email" → agree + pivot back to one question
   - "I'll think about it" → uncover the real hesitation
   - "We already have someone" → ask how it's going
5. Re-engage off-topic conversations with a bridge phrase
6. GOAL: Book a discovery call (get day + time) OR get strong interest → offer to connect them to the specialist right now
7. Rules: short sentences, mirror their energy, use name max twice, max 3 min unless engaged, end gracefully if not a fit
8. For Malaysian prospects: natural code-switching (BM/EN mix) builds rapport

Return JSON:
{
  "emailSubject": "...",
  "emailBody": "...",
  "whatsapp": "...",
  "voiceSystemPrompt": "..."
}`
    }]
  });

  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_from_offer' });
  return parseJSON(msg.content[0].text);
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
