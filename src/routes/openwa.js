import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getApiKey, saveApiKey } from '../services/apiKeys.js';
import { sendMessageToSession, testConnection, getQR, startNamedSession, stopNamedSession, getNamedSessionStatus } from '../services/openwa.js';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// ── Server config ────────────────────────────────────────────────────────────

router.get('/config', requireAuth, async (req, res, next) => {
  try {
    const url = await getApiKey('openwa_url');
    const key = await getApiKey('openwa_key');
    res.json({ configured: !!url, url: url ? url.replace(/^https?:\/\//, '') : '' });
  } catch (e) { next(e); }
});

router.post('/config', requireAdmin, async (req, res, next) => {
  try {
    const { url, apiKey } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    await saveApiKey('openwa_url', url);
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
    const { label, dailyLimit } = req.body;
    if (!label) return res.status(400).json({ error: 'Label required' });
    const sessionName = `kboos_${req.user.tenantId}_${Date.now()}`;
    const session = await prisma.openWASession.create({
      data: { tenantId: req.user.tenantId, label, sessionName, dailyLimit: dailyLimit || 200 },
    });
    res.json(session);
  } catch (e) { next(e); }
});

router.patch('/sessions/:id', requireAdmin, async (req, res, next) => {
  try {
    const { label, dailyLimit } = req.body;
    const session = await prisma.openWASession.update({
      where: { id: req.params.id },
      data: { ...(label ? { label } : {}), ...(dailyLimit ? { dailyLimit: parseInt(dailyLimit) } : {}) },
    });
    res.json(session);
  } catch (e) { next(e); }
});

router.delete('/sessions/:id', requireAdmin, async (req, res, next) => {
  try {
    const s = await prisma.openWASession.findUnique({ where: { id: req.params.id } });
    if (s) await stopNamedSession(s.sessionName).catch(() => {});
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
      await stopNamedSession(s.sessionName).catch(() => {});
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

// POST /openwa/campaigns/:id/launch — send messages respecting daily limit
router.post('/campaigns/:id/launch', requireAuth, async (req, res, next) => {
  try {
    const campaign = await prisma.wAConnectCampaign.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const session = await prisma.openWASession.findUnique({ where: { id: campaign.sessionId } });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Reset daily count if needed
    const now = new Date();
    const lastReset = new Date(session.lastResetAt);
    if (now.toDateString() !== lastReset.toDateString()) {
      await prisma.openWASession.update({ where: { id: session.id }, data: { sentToday: 0, lastResetAt: now } });
      session.sentToday = 0;
    }

    const remaining = session.dailyLimit - session.sentToday;
    if (remaining <= 0) return res.status(429).json({ error: `Daily limit of ${session.dailyLimit} reached for this number` });

    const toSend = Math.min(campaign.sendLimit, remaining);
    const leads = (campaign.leads || []).slice(campaign.sentCount, campaign.sentCount + toSend);
    const sequence = campaign.sequence || [];
    const firstMsg = sequence[0]?.message || '';

    if (!firstMsg) return res.status(400).json({ error: 'No message in sequence' });

    let sent = 0;
    const errors = [];

    // Spread sends — 1 message every ~30s to stay safe
    for (const lead of leads) {
      try {
        const msg = firstMsg.replace(/\{name\}/gi, lead.name || '').replace(/\{company\}/gi, lead.company || '');
        await sendMessageToSession(session.sessionName, lead.phone, msg);
        sent++;
        if (sent < leads.length) await new Promise(r => setTimeout(r, 30000)); // 30s gap
      } catch (err) {
        errors.push({ phone: lead.phone, error: err.message });
      }
    }

    await prisma.openWASession.update({ where: { id: session.id }, data: { sentToday: session.sentToday + sent } });
    await prisma.wAConnectCampaign.update({ where: { id: campaign.id }, data: { sentCount: campaign.sentCount + sent, status: 'active' } });

    res.json({ sent, errors, remaining: session.dailyLimit - session.sentToday - sent });
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
