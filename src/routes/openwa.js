import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getApiKey, saveApiKey } from '../services/apiKeys.js';
import { sendMessageToSession, testConnection, getQR, startNamedSession, stopNamedSession, disconnectNamedSession, getNamedSessionStatus, getWarmupLimit } from '../services/openwa.js';
import prisma from '../db.js';
const router = Router();
// ── Server config ────────────────────────────────────────────────────────────

router.get('/config', requireAuth, async (req, res, next) => {
  try {
    const url = await getApiKey('openwa_url');
    const key = await getApiKey('openwa_key');
    res.json({ configured: !!url, url: url || '' });
  } catch (e) { next(e); }
});

router.post('/config', requireAdmin, async (req, res, next) => {
  try {
    const { url, apiKey } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const raw = url.trim().replace(/\/$/, '');
    const withProto = raw.startsWith('http') ? raw : `https://${raw}`;
    const isLocal = /localhost|127\.0\.0\.1/.test(withProto);
    const normalized = (!isLocal && withProto.startsWith('http://')) ? withProto.replace('http://', 'https://') : withProto;
    await saveApiKey('openwa_url', normalized);
    if (apiKey) await saveApiKey('openwa_key', apiKey);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/config/test', requireAdmin, async (req, res, next) => {
  try {
    const { url, apiKey } = req.body;
    const ok = await testConnection(url, apiKey);
    res.json({ ok });
  } catch (e) { next(e); }
});

// Diagnose endpoint — shows exactly what WAHA returns so we can debug
router.get('/diagnose', requireAdmin, async (req, res, next) => {
  try {
    const { getApiKey: getKey } = await import('../services/apiKeys.js');
    const rawUrl = await getKey('openwa_url');
    const rawKey = await getKey('openwa_key');
    const { default: f } = await import('node-fetch').catch(() => ({ default: fetch }));
    const fetchFn = typeof fetch !== 'undefined' ? fetch : f;

    function norm(u) {
      const t = (u || '').trim().replace(/\/$/, '');
      const p = t.startsWith('http') ? t : `https://${t}`;
      return (!p.includes('localhost') && p.startsWith('http://')) ? p.replace('http://', 'https://') : p;
    }
    const base = norm(rawUrl);
    const headers = { 'Content-Type': 'application/json', ...(rawKey ? { 'X-API-Key': rawKey } : {}) };

    const r = await fetchFn(`${base}/api/sessions`, { headers, signal: AbortSignal.timeout(6000) });
    const body = await r.text();
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = body; }

    res.json({ storedUrl: rawUrl, normalizedUrl: base, httpStatus: r.status, sessions: parsed });
  } catch (e) { res.json({ error: e.message }); }
});

// ── Sessions (multi-number) ──────────────────────────────────────────────────

router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const sessions = await prisma.openWASession.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    // Refresh live status for each
    const withStatus = await Promise.all(sessions.map(async s => {
      const live = await getNamedSessionStatus(s.sessionName).catch(() => null);
      return { ...s, liveStatus: live?.status || s.status, phone: live?.phone || s.phone };
    }));
    res.json(withStatus);
  } catch (e) { next(e); }
});

router.post('/sessions', requireAdmin, async (req, res, next) => {
  try {
    const { label, phone, dailyLimit } = req.body;
    if (!label) return res.status(400).json({ error: 'Label required' });
    const sessionName = 'default'; // WAHA Core only supports 'default' session name

    // Logout + clear any existing session so new number gets a fresh QR
    const existing = await prisma.openWASession.findFirst({
      where: { tenantId: req.user.tenantId, sessionName },
    });
    if (existing) {
      await disconnectNamedSession(sessionName).catch(() => {});
      await prisma.openWASession.delete({ where: { id: existing.id } }).catch(() => {});
    }

    const session = await prisma.openWASession.create({
      data: { tenantId: req.user.tenantId, label, phone: phone || null, sessionName, dailyLimit: dailyLimit || 200 },
    });
    res.json(session);
  } catch (e) { next(e); }
});

router.patch('/sessions/:id', requireAdmin, async (req, res, next) => {
  try {
    const { label, dailyLimit, healthScore } = req.body;
    const session = await prisma.openWASession.update({
      where: { id: req.params.id },
      data: {
        ...(label ? { label } : {}),
        ...(dailyLimit ? { dailyLimit: parseInt(dailyLimit) } : {}),
        ...(healthScore !== undefined ? { healthScore: parseInt(healthScore) } : {}),
      },
    });
    res.json(session);
  } catch (e) { next(e); }
});

router.delete('/sessions/:id', requireAdmin, async (req, res, next) => {
  try {
    const s = await prisma.openWASession.findUnique({ where: { id: req.params.id } });
    if (s) await disconnectNamedSession(s.sessionName).catch(() => {});
    await prisma.openWASession.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /openwa/sessions/:id/connect — start session, return QR
router.post('/sessions/:id/connect', requireAdmin, async (req, res, next) => {
  try {
    const s = await prisma.openWASession.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const qr = await startNamedSession(s.sessionName);
    await prisma.openWASession.update({ where: { id: s.id }, data: { status: 'waiting_qr' } });
    res.json({ qr });
  } catch (e) { next(e); }
});

// GET /openwa/sessions/:id/qr — poll QR
router.get('/sessions/:id/qr', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.openWASession.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Not found' });
    const live = await getNamedSessionStatus(s.sessionName);
    if (live?.status === 'WORKING') {
      await prisma.openWASession.update({ where: { id: s.id }, data: { status: 'connected', phone: live.phone || s.phone } });
      return res.json({ connected: true, phone: live.phone });
    }
    const qr = await getQR(s.sessionName);
    res.json({ connected: false, qr });
  } catch (e) { next(e); }
});

// POST /openwa/sessions/:id/disconnect
router.post('/sessions/:id/disconnect', requireAdmin, async (req, res, next) => {
  try {
    const s = await prisma.openWASession.findUnique({ where: { id: req.params.id } });
    if (s) {
      await disconnectNamedSession(s.sessionName).catch(() => {});
      await prisma.openWASession.update({ where: { id: s.id }, data: { status: 'disconnected', phone: null } });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── WA Connect Campaigns ─────────────────────────────────────────────────────

router.get('/campaigns', requireAuth, async (req, res, next) => {
  try {
    const campaigns = await prisma.wAConnectCampaign.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(campaigns);
  } catch (e) { next(e); }
});

router.post('/campaigns', requireAuth, async (req, res, next) => {
  try {
    const { name, sessionId, goal, sequence, leads, sendLimit } = req.body;
    if (!name || !sessionId) return res.status(400).json({ error: 'name and sessionId required' });
    const campaign = await prisma.wAConnectCampaign.create({
      data: {
        tenantId: req.user.tenantId,
        name, sessionId, goal: goal || '',
        sequence: sequence || [],
        leads: leads || [],
        sendLimit: sendLimit || 50,
      },
    });
    res.json(campaign);
  } catch (e) { next(e); }
});

router.patch('/campaigns/:id', requireAuth, async (req, res, next) => {
  try {
    const { name, goal, sequence, leads, sendLimit, status } = req.body;
    const campaign = await prisma.wAConnectCampaign.update({
      where: { id: parseInt(req.params.id) },
      data: { ...(name && { name }), ...(goal !== undefined && { goal }), ...(sequence && { sequence }), ...(leads && { leads }), ...(sendLimit && { sendLimit }), ...(status && { status }) },
    });
    res.json(campaign);
  } catch (e) { next(e); }
});

router.delete('/campaigns/:id', requireAuth, async (req, res, next) => {
  try {
    await prisma.wAConnectCampaign.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PATCH /openwa/sessions/:id/warmup — toggle warmup mode
router.patch('/sessions/:id/warmup', requireAdmin, async (req, res, next) => {
  try {
    const { warmupEnabled } = req.body;
    const s = await prisma.openWASession.update({
      where: { id: req.params.id },
      data: { warmupEnabled: !!warmupEnabled },
    });
    res.json(s);
  } catch (e) { next(e); }
});

// GET /openwa/campaigns/:id/analytics
router.get('/campaigns/:id/analytics', requireAuth, async (req, res, next) => {
  try {
    const c = await prisma.wAConnectCampaign.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!c) return res.status(404).json({ error: 'Not found' });
    const leads = Array.isArray(c.leads) ? c.leads : [];
    const statuses = Array.isArray(c.leadStatuses) ? c.leadStatuses : [];
    const sent = statuses.filter(s => s.step >= 1).length;
    const replied = statuses.filter(s => s.replied).length;
    const optedOut = statuses.filter(s => s.optedOut).length;
    const step2 = statuses.filter(s => s.step >= 2).length;
    const step3 = statuses.filter(s => s.step >= 3).length;
    res.json({ total: leads.length, sent, replied, optedOut, step2, step3, sentToday: c.sentCount, sendLimit: c.sendLimit });
  } catch (e) { next(e); }
});

// POST /openwa/campaigns/:id/import-leads — import from KBOOS Lead Manager
router.post('/campaigns/:id/import-leads', requireAuth, async (req, res, next) => {
  try {
    const { leadIds } = req.body; // array of lead IDs
    if (!leadIds?.length) return res.status(400).json({ error: 'leadIds required' });
    const dbLeads = await prisma.lead.findMany({
      where: { id: { in: leadIds.map(Number) }, tenantId: req.user.tenantId },
      select: { id: true, name: true, phone: true, company: true },
    });
    const mapped = dbLeads.filter(l => l.phone).map(l => ({ name: l.name, phone: l.phone, company: l.company || '' }));
    const campaign = await prisma.wAConnectCampaign.findUnique({ where: { id: parseInt(req.params.id) } });
    const existing = Array.isArray(campaign?.leads) ? campaign.leads : [];
    const merged = [...existing, ...mapped.filter(n => !existing.some(e => e.phone === n.phone))];
    await prisma.wAConnectCampaign.update({
      where: { id: parseInt(req.params.id) },
      data: { leads: merged },
    });
    res.json({ imported: mapped.length, total: merged.length });
  } catch (e) { next(e); }
});

// POST /openwa/campaigns/:id/launch — send messages with warmup, rotation, A/B, lead status tracking
router.post('/campaigns/:id/launch', requireAuth, async (req, res, next) => {
  try {
    const campaign = await prisma.wAConnectCampaign.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Get all connected sessions for this tenant (for rotation)
    const allSessions = await prisma.openWASession.findMany({
      where: { tenantId: req.user.tenantId, status: 'connected' },
    });
    const targetSession = allSessions.find(s => s.id === campaign.sessionId) || allSessions[0];
    if (!targetSession) return res.status(400).json({ error: 'No connected WhatsApp number' });

    // Pre-flight: verify WAHA session is actually WORKING before attempting sends
    const liveStatus = await getNamedSessionStatus(targetSession.sessionName).catch(() => null);
    if (!liveStatus || liveStatus.status !== 'WORKING') {
      await prisma.openWASession.update({ where: { id: targetSession.id }, data: { status: 'disconnected' } }).catch(() => {});
      return res.status(400).json({
        error: `WhatsApp session is ${liveStatus?.status || 'unreachable'} — go to Settings → WA Connect and reconnect your number before launching.`,
        sessionStatus: liveStatus?.status,
      });
    }

    // Reset daily counts if needed
    const now = new Date();
    const resetPromises = allSessions.map(async s => {
      if (now.toDateString() !== new Date(s.lastResetAt).toDateString()) {
        // Also advance warmup week on new day
        const newWeek = s.warmupEnabled ? Math.min(s.warmupWeek + (now - new Date(s.lastResetAt) > 6 * 86400000 ? 1 : 0), 4) : s.warmupWeek;
        await prisma.openWASession.update({ where: { id: s.id }, data: { sentToday: 0, lastResetAt: now, warmupWeek: newWeek } });
        s.sentToday = 0;
      }
    });
    await Promise.all(resetPromises);

    // Effective limit (warmup or full)
    const effectiveLimit = targetSession.warmupEnabled ? getWarmupLimit(targetSession.warmupWeek) : targetSession.dailyLimit;
    const remaining = effectiveLimit - targetSession.sentToday;
    if (remaining <= 0) return res.status(429).json({ error: `Daily limit reached (${effectiveLimit}/day)${targetSession.warmupEnabled ? ' — warmup week ' + (targetSession.warmupWeek + 1) : ''}` });

    const toSend = Math.min(campaign.sendLimit, remaining);
    const leads = (campaign.leads || []);
    const leadStatuses = Array.isArray(campaign.leadStatuses) ? [...campaign.leadStatuses] : [];
    const currentStep = campaign.currentStep || 1;
    const sequence = campaign.sequence || [];
    const sequenceB = campaign.abVariantB || [];
    const useAB = campaign.abEnabled && sequenceB.length > 0;
    const stepMsg = sequence[currentStep - 1]?.message || sequence[0]?.message || '';
    if (!stepMsg) return res.status(400).json({ error: 'No message for this step' });

    // Filter leads who haven't had this step yet & not opted out
    const pendingLeads = leads.filter(l => {
      const st = leadStatuses.find(s => s.phone === l.phone);
      if (st?.optedOut) return false;
      if (st?.step >= currentStep) return false;
      return true;
    }).slice(0, toSend);

    // Smart rotation: use connected sessions round-robin
    let sent = 0; const errors = [];
    const sessionsToUse = allSessions.filter(s => {
      const eff = s.warmupEnabled ? getWarmupLimit(s.warmupWeek) : s.dailyLimit;
      return (eff - s.sentToday) > 0;
    });
    let sessionIdx = 0;

    for (const lead of pendingLeads) {
      try {
        // Pick session (rotate if multiple available)
        const sess = sessionsToUse[sessionIdx % sessionsToUse.length] || targetSession;
        sessionIdx++;
        const isVariantB = useAB && sessionIdx % 2 === 0;
        const msg = (isVariantB ? sequenceB[currentStep - 1]?.message || stepMsg : stepMsg)
          .replace(/\{name\}/gi, lead.name || '').replace(/\{company\}/gi, lead.company || '').replace(/\{first_name\}/gi, (lead.name || '').split(' ')[0]);

        await sendMessageToSession(sess.sessionName, lead.phone, msg);
        sent++;

        // Update lead status
        const existingIdx = leadStatuses.findIndex(s => s.phone === lead.phone);
        const newStatus = { phone: lead.phone, name: lead.name, step: currentStep, sentAt: new Date().toISOString(), variant: isVariantB ? 'B' : 'A' };
        if (existingIdx >= 0) leadStatuses[existingIdx] = { ...leadStatuses[existingIdx], ...newStatus };
        else leadStatuses.push(newStatus);

        await prisma.openWASession.update({ where: { id: sess.id }, data: { sentToday: { increment: 1 } } });

        // 30s gap only after successful sends (no delay on errors)
        if (sent < pendingLeads.length) await new Promise(r => setTimeout(r, 30000));
      } catch (err) {
        errors.push({ phone: lead.phone, error: err.message });
        await prisma.openWASession.update({ where: { id: targetSession.id }, data: { errorCount: { increment: 1 }, healthScore: { decrement: 2 } } }).catch(() => {});
        // If first send fails, it's likely a session issue — abort early to avoid waiting 30s × N
        if (sent === 0 && errors.length >= 2) break;
      }
    }

    await prisma.wAConnectCampaign.update({
      where: { id: campaign.id },
      data: { sentCount: { increment: sent }, status: sent > 0 ? 'active' : 'draft', leadStatuses },
    });

    res.json({ sent, errors, remaining: remaining - sent, warmupWeek: targetSession.warmupEnabled ? targetSession.warmupWeek + 1 : null });
  } catch (e) { next(e); }
});

// POST /openwa/send — quick test send
router.post('/send', requireAuth, async (req, res, next) => {
  try {
    const { sessionId, phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    const s = sessionId ? await prisma.openWASession.findUnique({ where: { id: sessionId } }) : null;
    const sessionName = s?.sessionName || 'default';
    const result = await sendMessageToSession(sessionName, phone, message);
    res.json({ ok: true, result });
  } catch (e) { next(e); }
});

export default router;
