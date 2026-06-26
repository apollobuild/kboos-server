import { getApiKey } from './apiKeys.js';
import prisma from '../db.js';
async function getConfig() {
  const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  const token = await getApiKey('wati');
  const url = await getApiKey('wati_url');
  if (!token) throw Object.assign(new Error('WATI token not configured. Go to Settings → API Keys.'), { status: 400 });
  return { token, baseUrl: url || 'https://live-server.wati.io' };
}

export async function sendMessage({ phone, message }) {
  const { token, baseUrl } = await getConfig();
  const res = await fetch(`${baseUrl}/api/v1/sendSessionMessage/${phone}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageText: message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false || data.ok === false) {
    throw new Error(watiError(data, res.status, 'session message'));
  }
  return data;
}

export async function sendTemplate({ phone, templateName, parameters, broadcastName = 'kboos_blast' }) {
  const { token, baseUrl } = await getConfig();
  const res = await fetch(`${baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_name: templateName, broadcast_name: broadcastName, parameters }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false || data.ok === false) {
    throw new Error(watiError(data, res.status, `template "${templateName}"`));
  }
  return data;
}

// Turn WATI's varied error shapes into a human-readable reason the campaign
// operator can act on
function watiError(data, status, context) {
  const raw = data?.info || data?.message || data?.error
    || (Array.isArray(data?.errors) ? data.errors.map(e => e.error || e.message).join('; ') : null)
    || data?.validationErrors
    || `HTTP ${status}`;
  let reason = typeof raw === 'string' ? raw : JSON.stringify(raw);
  // Map the most common causes to plain guidance
  if (/template.*not.*found|no.*template|invalid template/i.test(reason)) {
    reason = `WhatsApp template not found in WATI — check the template name is approved and spelled exactly. (${reason})`;
  } else if (/24|session|window|not.*open|expired/i.test(reason)) {
    reason = `Outside the 24-hour reply window — free-form messages can't be sent to this lead yet; an approved template is required. (${reason})`;
  } else if (/not.*opt|opt.?in|consent/i.test(reason)) {
    reason = `Lead has not opted in / not a valid WhatsApp contact. (${reason})`;
  } else if (/not enough credit|insufficient|out of credit|no credit|low balance|wallet|recharge|top.?up/i.test(reason)) {
    reason = `WATI account is out of credits — top up your WATI wallet (Billing/Wallet in the WATI dashboard) and confirm Meta WhatsApp billing is set up, then use "Retry failed" to resume. (${reason})`;
  } else if (status === 401 || status === 403) {
    reason = `WATI rejected the credentials — check the WATI token and API URL in Settings → API Keys. (${reason})`;
  } else if (status === 405 || status === 404) {
    reason = `WATI URL looks wrong — it must include your tenant ID, e.g. https://live-mt-server.wati.io/<tenantId> (copy it from WATI → API Docs). Set it in Settings → API Keys → WATI Server URL. (HTTP ${status})`;
  }
  return `WATI (${context}): ${reason}`;
}

export async function testConnection(token, baseUrl) {
  const res = await fetch(`${(baseUrl || 'https://live-server.wati.io')}/api/v1/getContacts?pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}
