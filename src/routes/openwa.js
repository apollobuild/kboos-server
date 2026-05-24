import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { saveApiKey, getApiKey } from '../services/apiKeys.js';
import { getSessionStatus, startSession, stopSession, sendMessage, testConnection } from '../services/openwa.js';

const router = Router();

// GET /openwa/status — session status + config presence
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const url = await getApiKey('openwa_url');
    const key = await getApiKey('openwa_key');
    if (!url) return res.json({ configured: false, connected: false, status: 'not_configured' });
    const status = await getSessionStatus();
    res.json({ configured: true, url: url.replace(/^https?:\/\//, ''), ...status });
  } catch (e) { next(e); }
});

// POST /openwa/settings — save URL + API key
router.post('/settings', requireAdmin, async (req, res, next) => {
  try {
    const { url, apiKey } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    await saveApiKey('openwa_url', url);
    if (apiKey) await saveApiKey('openwa_key', apiKey);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /openwa/test — test connectivity
router.post('/test', requireAdmin, async (req, res, next) => {
  try {
    const { url, apiKey } = req.body;
    const ok = await testConnection(url, apiKey);
    res.json({ ok });
  } catch (e) { next(e); }
});

// POST /openwa/session/start — create session + return QR
router.post('/session/start', requireAdmin, async (req, res, next) => {
  try {
    const result = await startSession();
    res.json(result);
  } catch (e) { next(e); }
});

// GET /openwa/session/qr — poll for live QR (frontend polls every 3s while waiting)
router.get('/session/qr', requireAuth, async (req, res, next) => {
  try {
    const url = await getApiKey('openwa_url');
    const key = await getApiKey('openwa_key');
    if (!url) return res.status(400).json({ error: 'OpenWA not configured' });
    const base = url.replace(/\/$/, '');
    const h = { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) };

    // Try screenshot first
    const imgRes = await fetch(`${base}/api/sessions/default/screenshot`, { headers: h });
    if (imgRes.ok) {
      const buf = await imgRes.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return res.json({ qr: `data:image/png;base64,${b64}` });
    }
    // Try JSON QR
    const jsonRes = await fetch(`${base}/api/sessions/default/auth/qr`, { headers: h });
    if (jsonRes.ok) {
      const d = await jsonRes.json();
      if (d.qr) return res.json({ qr: d.qr });
    }
    res.json({ qr: null });
  } catch (e) { next(e); }
});

// DELETE /openwa/session — disconnect
router.delete('/session', requireAdmin, async (req, res, next) => {
  try {
    await stopSession();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /openwa/send — send test message
router.post('/send', requireAuth, async (req, res, next) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    const result = await sendMessage({ phone, message });
    res.json({ ok: true, result });
  } catch (e) { next(e); }
});

export default router;
