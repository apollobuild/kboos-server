// Unified WhatsApp sender — routes to WATI or the official Meta Cloud API based
// on the `wa_provider` setting. This lets us migrate off WATI (a paid reseller
// on top of Meta) to our own Meta number WITHOUT changing the engine logic, and
// roll back instantly via one toggle.
//
// Resolution order (first wins): explicit per-campaign override → global
// `wa_provider` setting → WA_PROVIDER env → default 'wati'. So with nothing set,
// behaviour is exactly as before (WATI).
import { getApiKey } from './apiKeys.js';
import { sendMessage as watiSendMessage, sendTemplate as watiSendTemplate } from './wati.js';
import { sendTextMessage as metaSendText, sendTemplateMessage as metaSendTemplate } from './metaWa.js';

async function resolveProvider(explicit) {
  const raw = explicit
    || (await getApiKey('wa_provider').catch(() => null))
    || process.env.WA_PROVIDER
    || 'wati';
  return String(raw).toLowerCase() === 'meta' ? 'meta' : 'wati';
}

// Free-form message — only valid inside the 24h customer-service window.
export async function sendMessage({ phone, message, provider, waNumberId, tenantId }) {
  if (await resolveProvider(provider) === 'meta') {
    return metaSendText({ to: phone, text: message, waNumberId: waNumberId || undefined, tenantId });
  }
  return watiSendMessage({ phone, message });
}

// Approved template — required for cold outreach. WATI takes
// parameters:[{name,value}]; Meta takes components — convert the ordered
// {{1}},{{2}}… params to a Meta body component.
export async function sendTemplate({ phone, templateName, parameters, broadcastName, provider, languageCode, waNumberId, tenantId }) {
  if (await resolveProvider(provider) === 'meta') {
    const components = (parameters && parameters.length)
      ? [{ type: 'body', parameters: parameters.map(p => ({ type: 'text', text: p.value })) }]
      : [];
    return metaSendTemplate({ to: phone, templateName, languageCode: languageCode || 'en_US', components, waNumberId: waNumberId || undefined, tenantId });
  }
  return watiSendTemplate({ phone, templateName, parameters, broadcastName });
}
