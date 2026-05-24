import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './apiKeys.js';
import { logClaude } from './costLogger.js';

const UNSUB_REGEX = /\b(stop|unsubscribe|opt.?out|remove me|berhenti|jangan|tak nak|不要|退订)\b/i;
const HOT_REGEX   = /\b(interested|nak tahu lebih|nak jumpa|book|meeting|appointment|call me|hubungi|price|harga|berapa|bila boleh|when can|tell me more|how much|套餐|价格|预约)\b/i;

export async function processAutoReply({ reply, lead, biz, brief, threadHistory, aiReplyCount, maxReplies = 5 }) {
  // Safety limit
  if (aiReplyCount >= maxReplies) {
    return { stage: 'hot', shouldSend: false, shouldEscalate: true, reason: `Max ${maxReplies} AI replies reached — escalating` };
  }

  const msg = reply.msg || '';

  // Fast-path keyword detection before API call
  if (UNSUB_REGEX.test(msg)) {
    return { stage: 'unsub', response: null, shouldSend: false, shouldEscalate: true, isUnsub: true, reason: 'Unsubscribe intent detected' };
  }
  if (HOT_REGEX.test(msg)) {
    return { stage: 'hot', response: null, shouldSend: false, shouldEscalate: true, reason: 'High intent keywords detected' };
  }

  const key = await getApiKey('claude');
  if (!key) return null;

  const lang = lead.lang || 'EN';
  const langLabel = lang === 'MS' ? 'Bahasa Malaysia' : lang === 'ZH' ? 'Mandarin Chinese' : 'English';
  const bizName = biz?.name || 'our company';
  const offer = brief?.offer || brief?.service || '';
  const dreamOutcome = brief?.dreamOutcome || '';
  const audience = brief?.audience || '';

  // Build thread context (last 8 messages)
  const convoLines = (threadHistory || []).slice(-8).map(t => {
    const who = t.role === 'lead' ? (lead.name || 'Lead') : 'AI';
    return `${who}: ${t.msg || ''}`;
  }).join('\n');

  const client = new Anthropic({ apiKey: key });

  const result = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    system: `You are an AI sales assistant for ${bizName}.
${offer ? `We offer: ${offer}.` : ''}${dreamOutcome ? ` Outcome we deliver: ${dreamOutcome}.` : ''}${audience ? ` Our audience: ${audience}.` : ''}

Rules:
- Reply in ${langLabel}. Match the lead's language exactly.
- Be warm, genuine, and natural. Under 70 words.
- Never reveal you are AI.
- Never be pushy or salesy.
- If they seem interested/want pricing/want to meet → ESCALATE (do not try to close yourself).
- If they want to stop/unsubscribe → GOODBYE.
- Otherwise → CONTINUE the conversation naturally.

Respond with valid JSON only:
{ "action": "CONTINUE" | "ESCALATE" | "GOODBYE", "stage": "cold" | "warm" | "hot" | "unsub", "response": "your reply text or null if not CONTINUE", "reason": "one short sentence" }`,
    messages: [{
      role: 'user',
      content: `Lead: ${lead.name || 'Unknown'} at ${lead.company || ''} (${lead.title || ''})
Channel: ${reply.channel}
AI replies sent so far: ${aiReplyCount}

Conversation history:
${convoLines || '(first contact)'}

Latest message from ${lead.name || 'Lead'}:
"${msg}"

Respond with JSON.`,
    }],
  });

  logClaude({
    model: 'claude-haiku-4-5-20251001',
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    action: 'auto_reply',
  });

  let parsed;
  try {
    const text = result.content[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }

  if (!parsed) return null;

  return {
    stage:          parsed.stage || 'cold',
    response:       parsed.response || null,
    shouldSend:     parsed.action === 'CONTINUE' && !!parsed.response,
    shouldEscalate: parsed.action === 'ESCALATE' || parsed.action === 'GOODBYE',
    isUnsub:        parsed.action === 'GOODBYE',
    reason:         parsed.reason || '',
  };
}
