import { getApiKey } from './apiKeys.js';

async function getConfig() {
  const url = await getApiKey('openwa_url');
  const key = await getApiKey('openwa_key');
  return {
    baseUrl: (url || 'http://localhost:2785').replace(/\/$/, ''),
    apiKey: key || '',
  };
}

function makeHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
  };
}

export async function getSessionStatus() {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const res = await fetch(`${baseUrl}/api/sessions/default`, {
      headers: makeHeaders(apiKey),
    });
    if (res.status === 404) return { connected: false, status: 'no_session' };
    if (!res.ok) return { connected: false, status: 'error' };
    const data = await res.json();
    return {
      connected: data.status === 'WORKING',
      status: data.status,
      name: data.me?.pushname || null,
      phone: data.me?.user || null,
    };
  } catch {
    return { connected: false, status: 'unreachable' };
  }
}

export async function startSession() {
  const { baseUrl, apiKey } = await getConfig();
  const h = makeHeaders(apiKey);

  // Create session (ignore 422 if already exists)
  await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ name: 'default' }),
  });

  // Start the session
  await fetch(`${baseUrl}/api/sessions/default/start`, { method: 'POST', headers: h });

  // Poll for QR code (up to 15s)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const qrRes = await fetch(`${baseUrl}/api/sessions/default/screenshot`, { headers: h });
    if (qrRes.ok) {
      const buf = await qrRes.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const mime = qrRes.headers.get('content-type') || 'image/png';
      return { qr: `data:${mime};base64,${b64}` };
    }
    // Also try JSON QR endpoint
    const qrJson = await fetch(`${baseUrl}/api/sessions/default/auth/qr`, { headers: h });
    if (qrJson.ok) {
      const d = await qrJson.json();
      if (d.qr) return { qr: d.qr };
    }
  }
  throw new Error('QR code not available yet — try refreshing');
}

export async function stopSession() {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const res = await fetch(`${baseUrl}/api/sessions/default/stop`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
    });
    return res.ok;
  } catch { return false; }
}

export async function sendMessage({ phone, message, session = 'default' }) {
  const { baseUrl, apiKey } = await getConfig();
  const chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
  const res = await fetch(`${baseUrl}/api/sendText`, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({ chatId, text: message, session }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenWA: ${err}`);
  }
  return res.json();
}

export async function testConnection(url, key) {
  try {
    const base = (url || 'http://localhost:2785').replace(/\/$/, '');
    const res = await fetch(`${base}/api/sessions`, {
      headers: makeHeaders(key || ''),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}
