import { getApiKey } from './apiKeys.js';

export async function makeCall({ phone, leadName, bizName, campaignScript, phoneNumberId: overridePhoneId }) {
  const key = await getApiKey('vapi');
  const phoneNumId = overridePhoneId || await getApiKey('vapi_phone_number_id');
  if (!key) throw Object.assign(new Error('Vapi API key not configured'), { status: 400 });
  if (!phoneNumId) throw Object.assign(new Error('Vapi phone number ID not configured'), { status: 400 });
  if (!phone) throw Object.assign(new Error('Lead has no phone number'), { status: 400 });

  const res = await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phoneNumberId: phoneNumId,
      customer: { number: phone, name: leadName },
      assistant: {
        name: 'KOBIS Outreach Agent',
        firstMessage: `Hi, may I speak with ${leadName}?`,
        model: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          systemPrompt: campaignScript || `You are a professional outreach agent calling on behalf of ${bizName}. Be polite, concise and professional. Introduce yourself, briefly explain what ${bizName} offers, and ask if they'd be open to learning more. If they're interested, confirm their name and ask for the best time to follow up. If not interested, thank them politely and end the call.`,
          temperature: 0.7,
        },
        voice: { provider: '11labs', voiceId: 'rachel' },
        endCallMessage: 'Thank you for your time. Have a wonderful day!',
        recordingEnabled: true,
        maxDurationSeconds: 180,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = errText;
    try { errMsg = JSON.parse(errText).message || errText; } catch {}
    throw new Error(`Vapi: ${errMsg}`);
  }
  return res.json();
}

export async function getCallStatus(callId) {
  const key = await getApiKey('vapi');
  if (!key) throw new Error('Vapi API key not configured');
  const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) throw new Error('Failed to get call status');
  return res.json();
}

export async function testConnection(apiKey) {
  const res = await fetch('https://api.vapi.ai/phone-number', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  return res.status !== 401;
}
