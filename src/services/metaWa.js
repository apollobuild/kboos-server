import { getApiKey } from './apiKeys.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

async function getCreds() {
  const [token, phoneId, wabaId] = await Promise.all([
    getApiKey('meta_wa_token'),
    getApiKey('meta_wa_phone_id'),
    getApiKey('meta_wa_waba_id').catch(() => null),
  ]);
  if (!token) throw Object.assign(new Error('Meta WA access token not configured'), { status: 400 });
  if (!phoneId) throw Object.assign(new Error('Meta WA phone number ID not configured'), { status: 400 });
  return { token, phoneId, wabaId };
}

function authHeaders(token) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Send a free-form text message (only works within 24h customer service window)
export async function sendTextMessage({ to, text }) {
  const { token, phoneId } = await getCreds();
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalisePhone(to),
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Meta API error ${res.status}`);
  return { messageId: data.messages?.[0]?.id, status: 'sent' };
}

// Send an approved template message (required for cold outreach)
export async function sendTemplateMessage({ to, templateName, languageCode = 'en', components = [] }) {
  const { token, phoneId } = await getCreds();
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalisePhone(to),
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Meta API error ${res.status}`);
  return { messageId: data.messages?.[0]?.id, status: 'sent' };
}

// Build template components from variable map + lead data
// varMap: { '1': 'name', '2': 'company', '3': 'offer' }
export function buildComponents(varMap, lead, extraVars = {}) {
  const fields = { name: lead.name, company: lead.company, title: lead.title, phone: lead.phone, email: lead.email, ...extraVars };
  const params = Object.entries(varMap)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([, field]) => ({ type: 'text', text: fields[field] || field }));
  return params.length ? [{ type: 'body', parameters: params }] : [];
}

// List all approved templates in the WABA
export async function getTemplates() {
  const { token, wabaId } = await getCreds();
  if (!wabaId) return [];
  const res = await fetch(`${GRAPH}/${wabaId}/message_templates?status=APPROVED&limit=50&fields=name,status,language,components`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map(t => ({
    name: t.name,
    language: t.language,
    status: t.status,
    bodyText: t.components?.find(c => c.type === 'BODY')?.text || '',
    variables: extractVariables(t.components?.find(c => c.type === 'BODY')?.text || ''),
  }));
}

// Test connection by fetching phone number info
export async function testConnection() {
  const { token, phoneId } = await getCreds();
  const res = await fetch(`${GRAPH}/${phoneId}?fields=display_phone_number,verified_name,quality_rating`, {
    headers: authHeaders(token),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Connection failed');
  return { ok: true, phone: data.display_phone_number, name: data.verified_name, quality: data.quality_rating };
}

// Normalise phone: ensure it has country code, strip non-digits
function normalisePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length <= 11) return '60' + digits.slice(1);
  return digits;
}

// Extract {{1}}, {{2}} etc from template body text
function extractVariables(text) {
  const matches = text.match(/\{\{(\d+)\}\}/g) || [];
  return [...new Set(matches.map(m => m.replace(/[{}]/g, '')))].sort((a, b) => parseInt(a) - parseInt(b));
}
