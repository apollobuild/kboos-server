import { getApiKey } from './apiKeys.js';

function normalizeUrl(raw) {
  const trimmed = (raw || '').trim().replace(/\/$/, '');
  const withProto = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  const isLocal = /localhost|127\.0\.0\.1|192\.168\./.test(withProto);
  return (!isLocal && withProto.startsWith('http://')) ? withProto.replace('http://', 'https://') : withProto;
}

async function getConfig() {
  const url = await getApiKey('openwa_url');
  const key = await getApiKey('openwa_key');
  const baseUrl = normalizeUrl(url || 'http://localhost:2785');
  return { baseUrl, apiKey: key || '' };
}

function makeHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'X-Api-Key': apiKey } : {}), // WAHA uses X-Api-Key exactly
  };
}

function wlog(msg) { console.log(`[WAHA] ${msg}`); }

// WAHA API: GET /api/sessions/{session}
export async function getNamedSessionStatus(sessionName) {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionName}`, {
      headers: makeHeaders(apiKey),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return { status: 'no_session' };
    if (!res.ok) return { status: 'error', code: res.status };
    const data = await res.json();
    return {
      status: data.status,
      connected: data.status === 'WORKING',
      phone: data.me?.id?.user || data.me?.user || null,
      name: data.me?.pushName || data.me?.pushname || null,
    };
  } catch (e) {
    wlog(`getStatus error: ${e.message}`);
    return { status: 'unreachable' };
  }
}

// WAHA API: GET /api/{session}/auth/qr
export async function getQR(sessionName) {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const h = makeHeaders(apiKey);

    // Primary: GET /api/{session}/auth/qr — returns JSON { value: "data:image/..." }
    const jsonRes = await fetch(`${baseUrl}/api/${sessionName}/auth/qr`, {
      headers: h, signal: AbortSignal.timeout(5000),
    });
    if (jsonRes.ok) {
      const ct = jsonRes.headers.get('content-type') || '';
      if (ct.includes('image')) {
        const buf = await jsonRes.arrayBuffer();
        return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
      }
      const d = await jsonRes.json().catch(() => null);
      if (d?.value) return d.value;
      if (d?.qr) return d.qr;
    }

    // Try explicit image format
    const imgQrRes = await fetch(`${baseUrl}/api/${sessionName}/auth/qr?format=image`, {
      headers: h, signal: AbortSignal.timeout(5000),
    });
    if (imgQrRes.ok) {
      const ct = imgQrRes.headers.get('content-type') || '';
      if (ct.includes('image')) {
        const buf = await imgQrRes.arrayBuffer();
        return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
      }
    }

    // Screenshot fallback
    const scrRes = await fetch(`${baseUrl}/api/screenshot?session=${sessionName}`, {
      headers: h, signal: AbortSignal.timeout(5000),
    });
    if (scrRes.ok) {
      const ct = scrRes.headers.get('content-type') || '';
      if (ct.includes('image')) {
        const buf = await scrRes.arrayBuffer();
        return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
      }
      const d = await scrRes.json().catch(() => null);
      if (d?.value) return d.value;
    }

    return null;
  } catch { return null; }
}

export async function startNamedSession(sessionName) {
  const { baseUrl, apiKey } = await getConfig();
  const h = makeHeaders(apiKey);

  wlog(`Starting: ${sessionName} | URL: ${baseUrl}`);

  // Check existing state
  const existing = await getNamedSessionStatus(sessionName);
  wlog(`Existing status: ${existing.status}`);

  if (existing.status === 'WORKING') { wlog('Already connected'); return null; }

  if (existing.status === 'SCAN_QR_CODE') {
    wlog('Already at QR stage');
    const qr = await getQR(sessionName);
    if (qr) return qr;
  }

  // Stop any stuck session before retrying
  if (!['no_session', 'unreachable'].includes(existing.status)) {
    wlog(`Stopping stuck session (${existing.status})`);
    await fetch(`${baseUrl}/api/sessions/${sessionName}/stop`, {
      method: 'POST', headers: h, signal: AbortSignal.timeout(5000),
    }).catch(e => wlog(`Stop error: ${e.message}`));
    await new Promise(r => setTimeout(r, 1500));
  }

  // Step 1: WAHA v2 — POST /api/sessions { name, start: true }
  wlog('Trying WAHA v2: POST /api/sessions');
  const createRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ name: sessionName, start: true }),
    signal: AbortSignal.timeout(10000),
  }).catch(e => { wlog(`Create error: ${e.message}`); return null; });

  wlog(`Create status: ${createRes?.status}`);

  if (!createRes?.ok) {
    const errBody = createRes ? await createRes.text().catch(() => '') : 'no response';
    wlog(`Create failed (${createRes?.status}): ${errBody}`);

    // Step 2: session may already exist — try starting it
    wlog('Trying POST /api/sessions/{name}/start');
    const startRes = await fetch(`${baseUrl}/api/sessions/${sessionName}/start`, {
      method: 'POST', headers: h, signal: AbortSignal.timeout(10000),
    }).catch(e => { wlog(`Start error: ${e.message}`); return null; });
    wlog(`Start status: ${startRes?.status}`);

    if (!startRes?.ok) {
      // Step 3: WAHA v1 fallback
      wlog('Trying WAHA v1: POST /api/sessions/start');
      const v1Res = await fetch(`${baseUrl}/api/sessions/start`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ name: sessionName }),
        signal: AbortSignal.timeout(10000),
      }).catch(e => { wlog(`v1 error: ${e.message}`); return null; });
      wlog(`v1 status: ${v1Res?.status}`);

      if (!v1Res?.ok) {
        const v1Err = v1Res ? await v1Res.text().catch(() => '') : 'no response';
        wlog(`All start attempts failed. Last error: ${v1Err}`);
        throw new Error(`WAHA could not start session — check Railway WAHA logs. URL: ${baseUrl} | Error: ${v1Err || `HTTP ${v1Res?.status}`}`);
      }
    }
  }

  // Poll for QR — status-aware, up to 60s
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const live = await getNamedSessionStatus(sessionName);
    wlog(`Poll ${i + 1}/60: ${live.status}`);

    if (live.status === 'WORKING') { wlog('Connected!'); return null; }
    if (live.status === 'FAILED') throw new Error('WAHA session failed — check WAHA server logs');

    if (live.status === 'SCAN_QR_CODE') {
      const qr = await getQR(sessionName);
      if (qr) { wlog('QR obtained!'); return qr; }
    }
    // STARTING/STOPPED states: keep waiting
  }

  throw new Error('QR code not ready after 60s — check Railway → WAHA service logs for errors');
}

// WAHA API: POST /api/{session}/auth/logout — clears saved credentials so next connect needs fresh QR
export async function logoutNamedSession(sessionName) {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const h = makeHeaders(apiKey);
    // Try v2 endpoint first
    const r = await fetch(`${baseUrl}/api/${sessionName}/auth/logout`, {
      method: 'POST', headers: h, signal: AbortSignal.timeout(5000),
    });
    if (r.ok) { wlog(`Logged out ${sessionName}`); return true; }
    // v1 fallback
    await fetch(`${baseUrl}/api/sessions/logout`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: sessionName }),
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch (e) { wlog(`Logout error: ${e.message}`); return false; }
}

// WAHA API: POST /api/sessions/{name}/stop
export async function stopNamedSession(sessionName) {
  try {
    const { baseUrl, apiKey } = await getConfig();
    const res = await fetch(`${baseUrl}/api/sessions/${sessionName}/stop`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}

// Full disconnect: logout (clears credentials) then stop
export async function disconnectNamedSession(sessionName) {
  await logoutNamedSession(sessionName).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));
  await stopNamedSession(sessionName).catch(() => {});
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
    const base = normalizeUrl(url || '');
    if (!base) return false;
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
  const utc8 = new Date(now.getTime() + 8 * 3600000);
  const day = utc8.getUTCDay();
  const hour = utc8.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

export function getWarmupLimit(week) {
  const limits = [20, 50, 100, 150, 200];
  return limits[Math.min(week, limits.length - 1)];
}

export async function sendWithSafetyChecks(sessionName, phone, message) {
  if (!isBusinessHours()) throw new Error('Outside business hours (9am–6pm Mon–Fri)');
  return sendMessageToSession(sessionName, phone, message);
}
