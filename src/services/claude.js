import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './apiKeys.js';
import { logClaude } from './costLogger.js';
import { getMarketName } from './tenantConfig.js';

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

export async function generateBrief({ name, industry, website, service, audience, usps, tone, lang, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: `You are an expert B2B outreach strategist for ${market} SMEs. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `Generate outreach copy for ${name}, a ${industry} company in ${market}.
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

export async function generateEmail({ bizName, campaignName, prompt, lead, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const lang = lead.lang === 'MS' || lead.lang === 'BM' ? 'Bahasa Malaysia'
    : lead.lang === 'ZH' ? 'Mandarin Chinese'
    : 'English';
  const emailModel = 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model: emailModel,
    max_tokens: 1024,
    system: `You are a cold email expert specialising in ${market} B2B outreach. You write emails that get replies, not just opens.

Non-negotiable rules:
- Subject: under 7 words. Never starts with the company name or "I". Must use one of these formulas: curiosity gap ("Still losing leads to competitors in Johor?"), hyper-specific stat ("3 ${lead.title || 'managers'} in ${lead.company || 'your industry'} replied this week"), social proof ("How [Similar Co] added 40% pipeline"), or direct question ("Quick question about {{company}}")
- Body first line: NEVER starts with "I" — open with the prospect, their company, or a relevant observation
- Maximum 5 sentences before the CTA
- One CTA only — never give the reader multiple options
- Always end with a P.S. line — it gets read first and lifts reply rate significantly
- Banned words and phrases: synergy, leverage, solutions, world-class, "I hope this email finds you well", "please find attached", "I wanted to reach out", "touching base"
- Reference local market context where natural: relevant local business challenges
- Match relationship-first business culture in ${market}: warm tone, not aggressive American-style sales

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

export async function suggestReply({ message, senderName, company, channel, isHot, isUnsub, thread = [], persona = {}, goal = '', bizName = '', stage = 'cold', tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-sonnet-4-6';

  const personaName  = persona.name  || 'Amirah';
  const personaRole  = persona.role  || 'Business Development Executive';
  const personaStyle = persona.style || 'manglish'; // formal | casual | manglish

  const styleGuide = personaStyle === 'formal'
    ? 'Write formally. Full sentences. No slang. Professional sign-off.'
    : personaStyle === 'casual'
    ? 'Write casually. Short sentences. Friendly, warm tone. No formal greetings.'
    : `Write in a natural, locale-appropriate informal style for ${market} — mix local language and English naturally where it fits. Use colloquial expressions sparingly and only when it feels organic. Never sound forced.`;

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
    system: `You are ${personaName}, ${personaRole} at ${bizName || 'our company'} in ${market}. You are handling a ${channel} conversation with a potential client.

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

export async function generateSequence({ brief, persona, bizName, industry, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-sonnet-4-6';

  const offer = brief.offer || brief.service || '';
  const dreamOutcome = brief.dreamOutcome || brief.dream_outcome || '';
  const audience = brief.audience || brief.bestCustomer || brief.best_customer || '';
  const proof = brief.proof || brief.results || '';
  const timeToResult = brief.timeToResult || brief.time_to_result || '';
  const effortRemoved = brief.effortRemoved || brief.effort_removed || '';
  const riskReversal = brief.riskReversal || brief.risk_reversal || '';
  const goals = brief.goals || '';
  const style = brief.style || brief.communicationStyle || 'professional but warm';
  const lang = brief.lang || 'EN';

  const personaName = persona.name || 'Amirah';
  const personaRole = persona.role || 'Business Development Executive';

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `You are an elite B2B outreach strategist applying Hormozi's $100M Offers, Challenger Sale, and SPIN Selling frameworks. You build complete multi-channel outreach sequences for ${market} SMEs. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `Build a complete 5-touchpoint outreach sequence for ${bizName}, a ${industry} company.

OFFER DETAILS:
- Service/Offer: ${offer}
- Dream Outcome for client: ${dreamOutcome}
- Best Customer Profile: ${audience}
- Proof/Results: ${proof}
- Time to First Result: ${timeToResult}
- What We Handle (effort removed): ${effortRemoved}
- Risk Reversal/Guarantee: ${riskReversal}
- Sales Goals: ${goals}
- Communication Style: ${style}
- Language: ${lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English'}

AI PERSONA: ${personaName}, ${personaRole}

SEQUENCE RULES:
- Touchpoint 1 (Day 1): Cold Email — curiosity hook, no pitch, one soft question
- Touchpoint 2 (Day 3): WhatsApp — casual intro, reference the email, one question
- Touchpoint 3 (Day 7): Email Follow-up — add value (insight/stat), re-engage
- Touchpoint 4 (Day 10): WhatsApp Follow-up — short, direct, last easy ask
- Touchpoint 5 (Day 14): Voice Call — AI voice agent system prompt for warm follow-up after no WA/email response

For each touchpoint include:
- Concise, professional copy tailored to the offer
- Natural ${market} B2B tone (not American aggressive)
- {{first_name}}, {{company}}, {{title}}, {{city}} variables where natural

Also generate 5 common objection handlers (short, empathetic, pivoting responses).

Return JSON:
{
  "touchpoints": [
    {
      "id": "1",
      "day": 1,
      "channel": "email",
      "label": "Cold Email — Day 1",
      "subject": "email subject line",
      "body": "full message body",
      "notes": "why this works — brief internal note"
    },
    {
      "id": "2",
      "day": 3,
      "channel": "whatsapp",
      "label": "WhatsApp Intro — Day 3",
      "body": "whatsapp message",
      "notes": "internal note"
    },
    {
      "id": "3",
      "day": 7,
      "channel": "email",
      "label": "Value Follow-up — Day 7",
      "subject": "follow-up subject",
      "body": "follow-up email body",
      "notes": "internal note"
    },
    {
      "id": "4",
      "day": 10,
      "channel": "whatsapp",
      "label": "Final WA Touch — Day 10",
      "body": "final whatsapp message",
      "notes": "internal note"
    },
    {
      "id": "5",
      "day": 14,
      "channel": "voice",
      "label": "Voice Agent — Day 14",
      "body": "full AI voice agent system prompt (300-400 words behavioral instructions)",
      "notes": "internal note"
    }
  ],
  "objections": [
    { "id": "o1", "trigger": "Not interested", "response": "..." },
    { "id": "o2", "trigger": "Too busy right now", "response": "..." },
    { "id": "o3", "trigger": "We already have someone", "response": "..." },
    { "id": "o4", "trigger": "Send me more info", "response": "..." },
    { "id": "o5", "trigger": "Too expensive", "response": "..." }
  ]
}`
    }]
  });

  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_sequence' });
  return parseJSON(msg.content[0].text);
}

export async function regenerateTouchpoint({ brief, persona, bizName, touchpoint }) {
  const client = await getClient();
  const model = 'claude-haiku-4-5-20251001';

  const offer = brief.offer || brief.service || '';
  const dreamOutcome = brief.dreamOutcome || '';
  const audience = brief.bestCustomer || '';
  const style = brief.style || 'professional but warm';
  const lang = brief.lang || 'EN';

  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: `You are a B2B copywriter for Malaysian SMEs. Rewrite outreach copy for the given channel. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `Rewrite this ${touchpoint.channel} touchpoint for ${bizName}.

Offer: ${offer}
Dream Outcome: ${dreamOutcome}
Audience: ${audience}
Style: ${style}
Language: ${lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English'}

Current touchpoint:
Label: ${touchpoint.label}
Day: ${touchpoint.day}
${touchpoint.subject ? `Subject: ${touchpoint.subject}` : ''}
Body: ${touchpoint.body}

Write a fresh version — different angle, same goal. Keep {{variables}} intact.

Return JSON:
{
  ${touchpoint.channel === 'email' ? '"subject": "new subject line",' : ''}
  "body": "new message body",
  "notes": "what's different about this version"
}`
    }]
  });

  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'regen_touchpoint' });
  return parseJSON(msg.content[0].text);
}

export async function generateCampaignFromGoal({ bizId, goal, brief, industry, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model,
    max_tokens: 1500,
    system: `You are an expert B2B campaign strategist for ${market} SMEs. Given a business brief and a plain-English campaign goal, generate a complete campaign configuration. Local market context: WhatsApp is highly effective for SME owners, email works for corporate buyers, voice is best for high-ticket deals. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `BUSINESS BRIEF:
Name: ${brief.name || ''}
Industry: ${industry || brief.industry || ''}
Offer: ${brief.offer || brief.service || ''}
Dream Outcome: ${brief.dreamOutcome || ''}
Best Customer: ${brief.audience || brief.bestCustomer || ''}
Proof: ${brief.proof || ''}
Style: ${brief.style || 'professional'}
Language: ${brief.lang || 'EN'}

CAMPAIGN GOAL: "${goal}"

Generate the campaign config. Rules:
- channel: "wa" for SME/local targets, "wa_email" for corporate B2B, "full" for high-value deals >RM10k
- Derive Google Maps keyword from the goal (specific business type)
- Apollo job titles: 3-5 titles matching ideal buyer
- Sequence timing: Day 1 first touch, Day 3 follow-up alternate channel, Day 7 value email, Day 10 WA, Day 14 voice (only if full channel)
- Lead count: parse from goal if given, otherwise 200
- Email prompt: 2-sentence style brief for the email generator
- reasoning: 1-2 sentences explaining channel + timing choices

Return JSON:
{
  "name": "campaign name",
  "channel": "wa|wa_email|full",
  "channels": ["wa"] or ["wa","email"] or ["wa","email","call"],
  "sequence": [{"day":1,"type":"email","skipIfReplied":true}],
  "config": {
    "emailPrompt": "...",
    "waMessage": "opening WA message draft under 80 words with {{first_name}} and {{company}} variables",
    "voiceScript": "30-second voice agent opening if voice selected, else empty",
    "google_maps": {"keyword":"...","city":"...","limit":150},
    "apollo": {"job_titles":["..."],"industries":["..."],"limit":150}
  },
  "total": 200,
  "reasoning": "..."
}`
    }]
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_campaign' });
  return parseJSON(msg.content[0].text);
}

export async function analyzeCampaignPerformance({ campaign, stats, brief, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-sonnet-4-6';
  const msg = await client.messages.create({
    model,
    max_tokens: 800,
    system: `You are a campaign performance analyst for B2B outreach in ${market}. Analyse stats and return a grade, one key insight, and 1-3 concrete actions. Be direct and specific. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `CAMPAIGN: "${campaign.name}"
INDUSTRY: ${brief?.industry || campaign.bizName}
CHANNELS: ${campaign.channels?.join(', ') || 'unknown'}
DAYS RUNNING: ${stats.daysRunning}

STATS:
- Total leads: ${stats.totalLeads}
- Messages sent: ${stats.totalSent}
- Email open rate: ${stats.openRate}% (avg: 22%)
- WA response rate: ${stats.waResponseRate}% (benchmark: 8-15%)
- Hot leads: ${stats.hotCount}
- Email bounces: ${stats.emailBounces}

Return JSON:
{
  "grade": "A|B+|B|C|D",
  "gradeColor": "green|amber|red",
  "topInsight": "one specific observation",
  "actions": [
    {
      "priority": 1,
      "label": "short label",
      "detail": "specific actionable advice",
      "actionType": "update_config|add_leads|pause_channel|suggest_only"
    }
  ]
}`
    }]
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'campaign_performance' });
  return parseJSON(msg.content[0].text);
}

export async function prioritizeLeads({ leads, campaign, brief }) {
  const client = await getClient();
  const model = 'claude-haiku-4-5-20251001';
  const leadsSnapshot = leads.map(l => ({
    id: l.id,
    name: l.name,
    company: l.company,
    title: l.title,
    status: l.status,
    enriched: l.enriched,
    emailOpens: l._emailOpens || 0,
    waReplies: l._waReplies || 0,
    daysSinceContact: l._daysSinceContact || 99,
  }));
  const msg = await client.messages.create({
    model,
    max_tokens: 2000,
    system: `You are a B2B lead prioritization engine. Score leads 0-100 by conversion likelihood. Higher = more likely to convert now. Base on: recency, engagement depth (replied > opened > nothing), title seniority, enrichment. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `CAMPAIGN: "${campaign.name}"
OFFER: ${brief?.offer || brief?.service || ''}
TARGET: ${brief?.audience || brief?.bestCustomer || ''}

LEADS:
${JSON.stringify(leadsSnapshot)}

For each lead return: priorityScore(0-100), signals(1-3 strings), suggestedAction(1 sentence), prewrittenMessage(WA under 60 words using {{first_name}}).

Return JSON: {"ranked":[{"leadId":123,"priorityScore":85,"signals":["..."],"suggestedAction":"...","prewrittenMessage":"..."}]}`
    }]
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'prioritize_leads' });
  return parseJSON(msg.content[0].text);
}

export async function generateSmartFollowup({ lead, campaign, brief, history, channel }) {
  const client = await getClient();
  const model = 'claude-haiku-4-5-20251001';
  const msg = await client.messages.create({
    model,
    max_tokens: 400,
    system: `You are a B2B outreach specialist for Malaysian SMEs. Generate the optimal next message for a lead based on their engagement history. Be warm, specific, brief. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `LEAD: ${lead.name} at ${lead.company} (${lead.title})
STATUS: ${lead.status}
LANGUAGE: ${lead.lang || 'EN'}

OUTREACH HISTORY:
${history || 'No prior contact'}

OFFER: ${brief?.offer || brief?.service || ''}
PROOF: ${brief?.proof || ''}

CHANNEL: ${channel || 'pick best based on history'}

Rules: If they opened email but no reply, reference it. If WA unread after 2 touches, change angle entirely. Under 80 words for WA, 150 for email.

Return JSON:
{
  "channel": "wa|email|call",
  "message": "message text with {{first_name}} variable",
  "reasoning": "why this approach",
  "suggestedSendAt": "morning or afternoon"
}`
    }]
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'smart_followup' });
  return parseJSON(msg.content[0].text);
}

export async function generateCampaignAssets({ bizName, industry, offer, goal, dreamOutcome, targetAudience, tone, lang, channels = ['wa', 'email'], sampleLeads, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-opus-4-7';
  const langLabel = lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English';
  const hasEmail = channels.includes('email');
  const hasWa = channels.includes('wa');
  const hasVoice = channels.includes('call') || channels.includes('voice');

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `You are an elite B2B outreach copywriter for ${market} SMEs applying Hormozi's $100M Offers framework. Generate campaign assets that will be reused across all leads — no lead-specific details, only {{variables}} for personalisation. Language: ${langLabel}. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `Generate a full suite of outreach assets for this campaign.

BUSINESS: ${bizName}
INDUSTRY: ${industry}
OFFER: ${offer}
GOAL: ${goal || ''}
DREAM OUTCOME: ${dreamOutcome}
TARGET AUDIENCE: ${targetAudience}
TONE: ${tone}
CHANNELS: ${channels.join(', ')}${sampleLeads?.length ? `\nSAMPLE LEADS (representative of this campaign's audience):\n${sampleLeads.slice(0,5).map(l => `- ${l.company} (${l.category||l.industry||'Unknown'}) in ${l.address||market}`).join('\n')}` : ''}

RULES:
- Use {{opening_line}}, {{first_name}}, {{company}}, {{title}}, {{city}}, {{industry}} variables throughout
- {{opening_line}} is a hyper-personalised AI-generated first sentence injected per lead
- Subject lines: under 7 words, curiosity/stat/question formula, never start with "I" or company name
- Email bodies: under 130 words, open with THEIR situation not yours, one CTA, end with P.S. line
- WA messages: under 80 words, casual but professional, ends with one question
- Voice scripts: 300-400 word behavioral system prompt for an AI voice agent

Generate:
${hasEmail ? '- 4 email variants (different angles: curiosity, social proof, direct question, future pacing)' : ''}
${hasWa ? '- 3 WhatsApp variants (different hooks: benefit, problem, results)' : ''}
${hasVoice ? '- 2 voice variants (warm intro, direct opener)' : ''}

Return JSON:
{
  ${hasEmail ? `"emails": [
    {"assetType":"email_1","label":"Curiosity Hook — Email 1","subject":"...","body":"...","notes":"what makes this work"},
    {"assetType":"email_2","label":"Social Proof — Email 2","subject":"...","body":"...","notes":"..."},
    {"assetType":"email_3","label":"Direct Question — Email 3","subject":"...","body":"...","notes":"..."},
    {"assetType":"email_4","label":"Future Pacing — Email 4","subject":"...","body":"...","notes":"..."}
  ],` : '"emails": [],'}
  ${hasWa ? `"whatsapps": [
    {"assetType":"wa_1","label":"Benefit Hook — WA 1","body":"...","notes":"..."},
    {"assetType":"wa_2","label":"Problem Angle — WA 2","body":"...","notes":"..."},
    {"assetType":"wa_3","label":"Results Lead — WA 3","body":"...","notes":"..."}
  ],` : '"whatsapps": [],'}
  ${hasVoice ? `"voice": {
    "warm": {"assetType":"voice_warm","label":"Warm Intro Script","body":"full 300-400 word voice agent system prompt","notes":"..."},
    "direct": {"assetType":"voice_direct","label":"Direct Opener Script","body":"full system prompt","notes":"..."}
  }` : '"voice": null'}
}`
    }]
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_campaign_assets' });
  return parseJSON(msg.content[0].text);
}

export async function batchPersonalizeLeads({ bizName, offer, dreamOutcome, targetAudience, batch, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-haiku-4-5-20251001';

  const leadsText = batch.map(l =>
    `ID:${l.id} | ${l.name} | ${l.company} | ${l.category || 'Unknown'} | ${l.city || market} | Rating:${l.rating || 0}`
  ).join('\n');

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `You are a hyper-personalisation engine for B2B outreach in ${market}. Generate unique, specific opening lines for each lead. Each line must feel like it was written by a human who researched this specific company. Never generic. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: `CONTEXT:
Sending company: ${bizName}
Offer: ${offer}
Dream outcome we deliver: ${dreamOutcome}
Target audience: ${targetAudience}

LEADS (ID | Name | Company | Category | City | Rating):
${leadsText}

For each lead write:
- openingLine: 1-2 sentences that feel personally researched. Reference their category/city/business type naturally. Must lead naturally into the offer.
- variables: any extra personalisation tokens beyond the standard ones { first_name, company, title, city }

Rules:
- Never start with "I" — open with THEM
- Never use "I hope this email finds you well" or any banned phrases
- ${market} B2B context: can reference relevant local business challenges
- Opening lines should make the reader feel "this person knows my business"

Return JSON:
{
  "personalized": [
    {
      "leadId": 123,
      "openingLine": "Running a logistics outfit in Shah Alam with GST pressure and thin margins — sounds familiar.",
      "variables": { "industry_pain": "logistics margins" }
    }
  ]
}`
    }]
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'batch_personalize' });
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

export async function scoreLeadsWithAI({ leads, campaign }) {
  const client = await getClient();
  const model = 'claude-sonnet-4-6';

  const leadsSnapshot = leads.map(l => ({
    id: l.id,
    name: l.name,
    company: l.company,
    title: l.title,
    phone: l.phone,
    email: l.email,
    website: l.website,
    address: l.address,
    category: l.category,
    rating: l.rating,
    reviewCount: l.reviewCount,
    enriched: l.enriched,
    tier: l.tier,
  }));

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: 'You are a B2B lead scoring engine. Score each lead 0-100 based on: data completeness, business quality, decision-maker seniority, contact reachability. Return only valid JSON.',
    messages: [{
      role: 'user',
      content: `CAMPAIGN: "${campaign.name}"
OFFER: ${campaign.offer || ''}
GOAL: ${campaign.goal || ''}
TARGET AUDIENCE: ${campaign.targetAudience || ''}

LEADS:
${JSON.stringify(leadsSnapshot)}

Score each lead 0-100. Tier: A=70+, B=40-69, C<40.

Return JSON:
{
  "scored": [
    { "leadId": 123, "aiScore": 85, "aiScoreReason": "Has email + phone, high-rated business, clear decision maker", "tier": "A" }
  ]
}`
    }]
  });

  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'ai_score_leads' });
  return parseJSON(msg.content[0].text);
}

export async function generateOptimizationSuggestions({ campaign, metrics }) {
  const client = await getClient();
  const model = 'claude-sonnet-4-6';

  const msg = await client.messages.create({
    model,
    max_tokens: 2048,
    system: 'You are a B2B outreach optimization analyst for Malaysia. Analyse campaign metrics and suggest specific, actionable improvements. Return only valid JSON.',
    messages: [{
      role: 'user',
      content: `CAMPAIGN: "${campaign.name}"
CHANNELS: ${(campaign.channels || []).join(', ')}
OFFER: ${campaign.offer || ''}
GOAL: ${campaign.goal || ''}

METRICS:
- Emails sent: ${metrics.emailsSent}
- WA sent: ${metrics.waSent}
- Calls made: ${metrics.callsMade}
- Open rate: ${metrics.openRate}%
- Reply rate: ${metrics.replyRate}%
- Meetings booked: ${metrics.meetingsBooked}
- Days running: ${metrics.daysRunning}
- Tier breakdown: ${JSON.stringify(metrics.tierBreakdown || {})}

Generate up to 5 specific, actionable improvement suggestions.

Return JSON:
{
  "suggestions": [
    {
      "priority": 1,
      "category": "subject|message|timing|channel|targeting",
      "title": "short title",
      "detail": "specific actionable advice",
      "impact": "high|medium|low"
    }
  ]
}`
    }]
  });

  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'optimization_suggestions' });
  return parseJSON(msg.content[0].text);
}

export async function generateOutreachAssets({ bizName, industry, offer, targetAudience, goal, tone, lang, channels, dreamOutcome, tenantConfig = {} }) {
  const tc = tenantConfig;
  const market = getMarketName(tc.country || 'MY');
  const client = await getClient();
  const model = 'claude-opus-4-7';

  const wantEmail = channels.includes('email');
  const wantWa = channels.includes('wa');
  const wantVoice = channels.includes('voice');

  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `You are an expert B2B outreach copywriter for ${market} SMEs. Write compelling, concise outreach content.
Language: ${lang === 'BM' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Chinese (Simplified)' : 'English'}
Tone: ${tone}
Return only valid JSON, no extra text.`,
    messages: [{
      role: 'user',
      content: `Generate outreach assets for this business:
Business: ${bizName}${industry ? ` (${industry})` : ''}
Offer: ${offer}
Target Audience: ${targetAudience}
Goal: ${goal || dreamOutcome || 'Book a discovery call'}

${wantEmail ? `Generate 2 email variants (cold intro + follow-up). Each: subject line + body under 150 words.` : ''}
${wantWa ? `Generate 2 WhatsApp messages (intro + follow-up). Each under 60 words, conversational.` : ''}
${wantVoice ? `Generate 1 voice call script under 60 seconds. Include warm opener and clear value prop.` : ''}

Return JSON:
{
  ${wantEmail ? `"emails": [
    { "label": "Email 1 — Cold Intro", "assetType": "email_1", "subject": "...", "body": "..." },
    { "label": "Email 2 — Follow-up", "assetType": "email_2", "subject": "...", "body": "..." }
  ],` : '"emails": [],'}
  ${wantWa ? `"whatsapps": [
    { "label": "WA 1 — Intro", "assetType": "wa_1", "body": "..." },
    { "label": "WA 2 — Follow-up", "assetType": "wa_2", "body": "..." }
  ],` : '"whatsapps": [],'}
  ${wantVoice ? `"voice": { "label": "Voice Script", "assetType": "voice_1", "body": "..." }` : '"voice": null'}
}`,
    }],
  });

  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_outreach_assets' });
  return parseJSON(msg.content[0].text);
}

export async function generateWASequence({ goal, steps = 3, tenantConfig = {} }) {
  const client = await getClient();
  const model = 'claude-sonnet-4-6';
  const market = getMarketName(tenantConfig.country);
  const msg = await client.messages.create({
    model,
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are a WhatsApp outreach copywriter. Generate a ${steps}-message follow-up sequence for this goal:

Goal: ${goal}
Market: ${market || 'general B2B'}

Rules:
- Each message under 60 words
- Conversational, not salesy
- Use {name} for lead name, {company} for company name
- Space messages over days (suggest delay for each)
- Each message should feel natural on WhatsApp

Return JSON array:
[
  { "day": 1, "label": "Intro", "message": "..." },
  { "day": 3, "label": "Follow-up", "message": "..." },
  { "day": 7, "label": "Final", "message": "..." }
]
Only return valid JSON, no extra text.`,
    }],
  });
  logClaude({ model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, action: 'generate_wa_sequence' });
  return parseJSON(msg.content[0].text);
}
