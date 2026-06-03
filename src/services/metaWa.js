import { getApiKey } from './apiKeys.js';
import prisma from '../db.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

// Get shared token + fallback single phone number from settings
async function getToken() {
  const token = await getApiKey('meta_wa_token');
  if (!token) throw Object.assign(new Error('Meta WA access token not configured'), { status: 400 });
  return token;
}

// Get creds for a specific phoneNumberId, or auto-select from MetaWANumber table
// Priority: explicit id > campaign waNumberId > auto-select by remaining capacity > legacy single key
async function getCreds({ phoneNumberId, waNumberId, tenantId = 'default' } = {}) {
  const token = await getToken();
  const wabaId = await getApiKey('meta_wa_waba_id').catch(() => null);

  // 1. Explicit phoneNumberId passed directly
  if (phoneNumberId) return { token, phoneId: phoneNumberId, wabaId };

  // 2. Specific number record by DB id
  if (waNumberId) {
    const num = await prisma.metaWANumber.findUnique({ where: { id: waNumberId } }).catch(() => null);
    if (num?.active) return { token, phoneId: num.phoneNumberId, wabaId, numRecord: num };
  }

  // 3. Auto-select: pick active number with most remaining daily capacity
  await resetDailyCountsIfNeeded(tenantId);
  const numbers = await prisma.metaWANumber.findMany({
    where: { tenantId, active: true },
    orderBy: { sentToday: 'asc' },
  }).catch(() => []);

  if (numbers.length > 0) {
    const best = numbers.find(n => n.sentToday < n.dailyLimit) || numbers[0];
    return { token, phoneId: best.phoneNumberId, wabaId, numRecord: best };
  }

  // 4. Fallback: legacy single number from API keys
  const legacyPhoneId = await getApiKey('meta_wa_phone_id').catch(() => null);
  if (!legacyPhoneId) throw Object.assign(new Error('No WhatsApp numbers configured. Add one in Settings → WhatsApp Connect.'), { status: 400 });
  return { token, phoneId: legacyPhoneId, wabaId };
}

// Reset sentToday for any number that hasn't been reset today
async function resetDailyCountsIfNeeded(tenantId = 'default') {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  await prisma.metaWANumber.updateMany({
    where: { tenantId, lastResetAt: { lt: today } },
    data: { sentToday: 0, lastResetAt: new Date() },
  }).catch(() => {});
}

function authHeaders(token) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Send a free-form text message (only works within 24h customer service window)
export async function sendTextMessage({ to, text, phoneNumberId, waNumberId, tenantId }) {
  const { token, phoneId, numRecord } = await getCreds({ phoneNumberId, waNumberId, tenantId });
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
  if (numRecord) {
    await prisma.metaWANumber.update({ where: { id: numRecord.id }, data: { sentToday: { increment: 1 } } }).catch(() => {});
  }
  return { messageId: data.messages?.[0]?.id, status: 'sent', phoneId };
}

// Send an approved template message (required for cold outreach)
export async function sendTemplateMessage({ to, templateName, languageCode = 'en', components = [], phoneNumberId, waNumberId, tenantId }) {
  const { token, phoneId, numRecord } = await getCreds({ phoneNumberId, waNumberId, tenantId });
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
  if (numRecord) {
    await prisma.metaWANumber.update({ where: { id: numRecord.id }, data: { sentToday: { increment: 1 } } }).catch(() => {});
  }
  return { messageId: data.messages?.[0]?.id, status: 'sent', phoneId };
}

// Build template components from variable map + lead data
export function buildComponents(varMap, lead, extraVars = {}) {
  const fields = { name: lead.name, company: lead.company, title: lead.title, phone: lead.phone, email: lead.email, ...extraVars };
  const params = Object.entries(varMap)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([, field]) => ({ type: 'text', text: fields[field] || field }));
  return params.length ? [{ type: 'body', parameters: params }] : [];
}

// List all approved templates in the WABA
export async function getTemplates() {
  const token = await getToken();
  const wabaId = await getApiKey('meta_wa_waba_id').catch(() => null);
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

// Test connection on a specific phoneNumberId or the first active number
export async function testConnection(phoneNumberId) {
  const token = await getToken();
  const phoneId = phoneNumberId || await getApiKey('meta_wa_phone_id').catch(() => null);
  if (!phoneId) {
    const first = await prisma.metaWANumber.findFirst({ where: { active: true } }).catch(() => null);
    if (!first) throw new Error('No phone number configured');
    return testPhoneId(token, first.phoneNumberId);
  }
  return testPhoneId(token, phoneId);
}

async function testPhoneId(token, phoneId) {
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

function extractVariables(text) {
  const matches = text.match(/\{\{(\d+)\}\}/g) || [];
  return [...new Set(matches.map(m => m.replace(/[{}]/g, '')))].sort((a, b) => parseInt(a) - parseInt(b));
}
