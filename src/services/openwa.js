import { getApiKey } from './apiKeys.js';

async function getConfig() {
  const url = await getApiKey('openwa_url');
  const key = await getApiKey('openwa_key');
  const raw = (url || 'http://localhost:2785').replace(/\/$/, '');
  const baseUrl = raw.startsWith('http') ? raw : `https://${raw}`;
  return { baseUrl, apiKey: key || '' };
}

function makeHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
  };
}

// WAHA API: GET /api/sessions/{session}
export async function getNamedSessionStatus(sessionName) {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionName}`, {
      headers: makeHeaders(apiKey),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) return { status: 'no_session' };
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    return {
      status: data.status,
      connected: data.status === 'WORKING',
      phone: data.me?.id?.user || data.me?.user || null,
      name: data.me?.pushName || data.me?.pushname || null,
    };
  } catch {
    return { status: 'unreachable' };
  }
}

// WAHA API: POST /api/sessions/start  { name }
export async function startNamedSession(sessionName) {
  const { baseUrl, apiKey } = await getConfig();
  const h = makeHeaders(apiKey);

  // Start session (WAHA uses /api/sessions/start)
  await fetch(`${baseUrl}/api/sessions/start`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ name: sessionName }),
  });

  // Poll for QR up to 20s
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const qr = await getQR(sessionName);
    if (qr) return qr;
  }
  throw new Error('QR code not ready — try refreshing');
}

// WAHA API: GET /api/{session}/auth/qr  or  GET /api/screenshot?session={session}
export async function getQR(sessionName) {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const h = makeHeaders(apiKey);

    // Try WAHA QR JSON endpoint first
    const jsonRes = await fetch(`${baseUrl}/api/${sessionName}/auth/qr`, { headers: h, signal: AbortSignal.timeout(4000) });
    if (jsonRes.ok) {
      const d = await jsonRes.json();
      // WAHA returns { value: "data:image/png;base64,..." }
      if (d.value) return d.value;
      if (d.qr) return d.qr;
    }

    // Fallback: screenshot endpoint GET /api/screenshot?session=name
    const imgRes = await fetch(`${baseUrl}/api/screenshot?session=${sessionName}`, { headers: h, signal: AbortSignal.timeout(4000) });
    if (imgRes.ok) {
      const ct = imgRes.headers.get('content-type') || '';
      if (ct.includes('image')) {
        const buf = await imgRes.arrayBuffer();
        return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
      }
      const d = await imgRes.json().catch(() => null);
      if (d?.value) return d.value;
    }
    return null;
  } catch { return null; }
}

// WAHA API: POST /api/sessions/stop  { name }
export async function stopNamedSession(sessionName) {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const res = await fetch(`${baseUrl}/api/sessions/stop`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({ name: sessionName }),
    });
    return res.ok;
  } catch { return false; }
}

// WAHA API: POST /api/sendText  { chatId, text, session }
export async function sendMessageToSession(sessionName, phone, message) {
  const { baseUrl, apiKey } = await getConfig();
  const chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
  const res = await fetch(`${baseUrl}/api/sendText`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({ chatId, text: message, session: sessionName }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WAHA: ${err}`);
  }
  return res.json();
}

export async function testConnection(url, key) {
  try {
    const raw = (url || '').replace(/\/$/, '');
    const base = raw.startsWith('http') ? raw : `https://${raw}`;
    const res = await fetch(`${base}/api/sessions`, {
      headers: makeHeaders(key || ''),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}

// Legacy single-session compat
export async function sendMessage({ phone, message }) {
  return sendMessageToSession('default', phone, message);
}

const STOP_WORDS = ['stop', 'unsubscribe', 'opt out', 'remove me', 'don\'t contact', 'do not contact', 'berhenti', 'tak nak', 'no thanks', 'not interested', 'buang'];

export function isStopWord(text) {
  const lower = text.toLowerCase().trim();
  return STOP_WORDS.some(w => lower.includes(w));
}

export function isBusinessHours() {
  const now = new Date();
  // Convert to UTC+8 (KL/SG time)
  const utc8 = new Date(now.getTime() + 8 * 3600000);
  const day = utc8.getUTCDay(); // 0=Sun, 6=Sat
  const hour = utc8.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

// Warmup: returns effective daily limit based on warmup week
export function getWarmupLimit(week) {
  const limits = [20, 50, 100, 150, 200];
  return limits[Math.min(week, limits.length - 1)];
}

export async function sendWithSafetyChecks(sessionName, phone, message) {
  // Only send during business hours
  if (!isBusinessHours()) {
    throw new Error('Outside business hours (9am–6pm Mon–Fri)');
  }
  return sendMessageToSession(sessionName, phone, message);
}
