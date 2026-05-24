import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { saveApiKey, getApiKey } from '../services/apiKeys.js';
import { testConnection as testClaude } from '../services/claude.js';
import { testConnection as testSendGrid, sendEmail } from '../services/sendgrid.js';
import { testConnection as testWati } from '../services/wati.js';
import { testConnection as testOutscraper } from '../services/outscraper.js';
import { testConnection as testVapi } from '../services/vapi.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } }) || {};
    // Mask key values
    const keys = {};
    for (const api of ['claude', 'sendgrid', 'wati', 'wati_url', 'apollo', 'outscraper', 'billplz_api_key', 'billplz_collection_id', 'billplz_x_signature_key', 'vapi', 'vapi_phone_number_id']) {
      const val = await getApiKey(api);
      keys[api] = val ? '••••••••' + val.slice(-4) : '';
    }
    res.json({ ...s, apiKeys: keys });
  } catch (e) { next(e); }
});

router.post('/api-key', requireAuth, async (req, res, next) => {
  try {
    const { api, value } = req.body;
    await saveApiKey(api, value);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/test-connection/:api', requireAuth, async (req, res, next) => {
  try {
    const api = req.params.api;
    const key = await getApiKey(api);
    if (!key) return res.json({ ok: false, error: 'No key saved' });
    let ok = false;
    if (api === 'claude') ok = await testClaude(key).catch(() => false);
    else if (api === 'sendgrid') ok = await testSendGrid(key).catch(() => false);
    else if (api === 'wati') { const url = await getApiKey('wati_url'); ok = await testWati(key, url).catch(() => false); }
    else if (api === 'outscraper') ok = await testOutscraper(key).catch(() => false);
    else if (api === 'vapi') ok = await testVapi(key).catch(() => false);
    else ok = !!key;
    res.json({ ok });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/team', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } }) || { team: [] };
    const team = [...(s.team || []), { id: Date.now(), ...req.body }];
    await prisma.appSettings.upsert({ where: { id: 'global' }, create: { id: 'global', team }, update: { team } });
    res.json({ ok: true, team });
  } catch (e) { next(e); }
});

router.delete('/team/:id', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const team = (s?.team || []).filter(m => String(m.id) !== req.params.id);
    await prisma.appSettings.update({ where: { id: 'global' }, data: { team } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/users', requireAdmin, async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, bizId: true, createdAt: true, lastLoginAt: true, inviteToken: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map(u => ({ ...u, pending: !!u.inviteToken, inviteToken: undefined })));
  } catch (e) { next(e); }
});

router.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const { role } = req.body;
    const allowed = ['admin', 'operator', 'viewer'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role },
      select: { id: true, email: true, name: true, role: true, createdAt: true, lastLoginAt: true, inviteToken: true },
    });
    res.json({ ...user, pending: !!user.inviteToken, inviteToken: undefined });
  } catch (e) { next(e); }
});

router.post('/users/:id/resend-invite', requireAdmin, async (req, res, next) => {
  try {
    const { randomBytes } = await import('crypto');
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const inviteToken = randomBytes(32).toString('hex');
    await prisma.user.update({ where: { id: req.params.id }, data: { inviteToken } });

    const frontendUrl = process.env.FRONTEND_URL || 'https://kboos-production.up.railway.app';
    const inviteLink = `${frontendUrl}?invite=${inviteToken}`;

    try {
      const sgKey = await getApiKey('sendgrid');
      if (sgKey) {
        await sendEmail({
          to: user.email,
          subject: 'Your KOBIS Outreach OS invite link',
          body: `Hi ${user.name},\n\nHere is your new invite link to set your password:\n\n${inviteLink}\n\nKOBIS Team`,
        });
      }
    } catch { /* email optional */ }

    res.json({ inviteLink });
  } catch (e) { next(e); }
});

router.delete('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Prompt Templates ──
router.get('/prompt-templates', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    res.json(s?.promptTemplates || []);
  } catch (e) { next(e); }
});

router.post('/prompt-templates', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const existing = (s?.promptTemplates || []);
    const newTemplate = {
      id: `v${Date.now()}`,
      label: req.body.label || `v${existing.length + 1} — Custom`,
      active: req.body.active || false,
      content: req.body.content,
      openRate: req.body.openRate || '—',
      replyRate: req.body.replyRate || '—',
      createdAt: new Date().toISOString(),
    };
    // If setting as active, deactivate others
    const updated = req.body.active
      ? existing.map(t => ({ ...t, active: false }))
      : existing;
    const promptTemplates = [newTemplate, ...updated];
    await prisma.appSettings.upsert({ where: { id: 'global' }, create: { id: 'global', promptTemplates }, update: { promptTemplates } });
    res.json(newTemplate);
  } catch (e) { next(e); }
});

router.patch('/prompt-templates/:id', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    let templates = s?.promptTemplates || [];
    // If activating, deactivate all others first
    if (req.body.active) templates = templates.map(t => ({ ...t, active: false }));
    templates = templates.map(t => t.id === req.params.id ? { ...t, ...req.body } : t);
    await prisma.appSettings.update({ where: { id: 'global' }, data: { promptTemplates: templates } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/prompt-templates/:id', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const promptTemplates = (s?.promptTemplates || []).filter(t => t.id !== req.params.id);
    await prisma.appSettings.update({ where: { id: 'global' }, data: { promptTemplates } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/prompt-templates/:id/test-send', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const template = (s?.promptTemplates || []).find(t => t.id === req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const fill = str => (str || '')
      .replace(/\{\{first_name\}\}/g, 'Ahmad')
      .replace(/\{\{company\}\}/g, 'Naim Holdings')
      .replace(/\{\{industry\}\}/g, 'Construction')
      .replace(/\{\{city\}\}/g, 'Kuching')
      .replace(/\{\{title\}\}/g, 'Manager')
      .replace(/\{\{phone\}\}/g, '+6012-345 6789');

    const subject = fill(template.subject || template.label || 'Test Email');
    const body = fill(template.body || template.content || '');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.email) return res.status(400).json({ error: 'No email on your account' });

    await sendEmail({ to: user.email, subject: `[TEST] ${subject}`, body });
    res.json({ ok: true, sentTo: user.email });
  } catch (e) { next(e); }
});

// ── Generic template CRUD factory ──
function registerTemplateCRUD(router, routePrefix, settingsField) {
  router.get(`/${routePrefix}`, requireAuth, async (req, res, next) => {
    try {
      const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
      res.json(s?.[settingsField] || []);
    } catch (e) { next(e); }
  });

  router.post(`/${routePrefix}`, requireAuth, async (req, res, next) => {
    try {
      const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
      const existing = s?.[settingsField] || [];
      const newTpl = {
        id: `v${Date.now()}`,
        label: req.body.label || `v${existing.length + 1} — Custom`,
        active: req.body.active || false,
        body: req.body.body || req.body.content || '',
        lang: req.body.lang || 'all',
        type: req.body.type || routePrefix.replace('-templates', ''),
        stats: { opens: 0, replies: 0 },
        createdAt: new Date().toISOString(),
      };
      const updated = req.body.active ? existing.map(t => ({ ...t, active: false })) : existing;
      const templates = [newTpl, ...updated];
      await prisma.appSettings.upsert({ where: { id: 'global' }, create: { id: 'global', [settingsField]: templates }, update: { [settingsField]: templates } });
      res.json(newTpl);
    } catch (e) { next(e); }
  });

  router.patch(`/${routePrefix}/:id`, requireAuth, async (req, res, next) => {
    try {
      const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
      let templates = s?.[settingsField] || [];
      if (req.body.active) templates = templates.map(t => ({ ...t, active: false }));
      templates = templates.map(t => t.id === req.params.id ? { ...t, ...req.body } : t);
      await prisma.appSettings.update({ where: { id: 'global' }, data: { [settingsField]: templates } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.delete(`/${routePrefix}/:id`, requireAuth, async (req, res, next) => {
    try {
      const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
      const templates = (s?.[settingsField] || []).filter(t => t.id !== req.params.id);
      await prisma.appSettings.update({ where: { id: 'global' }, data: { [settingsField]: templates } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

registerTemplateCRUD(router, 'wa-templates', 'waTemplates');
registerTemplateCRUD(router, 'voice-templates', 'voiceTemplates');

// ── Preferences (notifications + branding) ──
router.patch('/preferences', requireAuth, async (req, res, next) => {
  try {
    const { notifications, branding } = req.body;
    const data = {};
    if (notifications !== undefined) data.notifications = notifications;
    if (branding !== undefined) data.branding = branding;
    if (Object.keys(data).length === 0) return res.json({ ok: true });
    await prisma.appSettings.upsert({ where: { id: 'global' }, create: { id: 'global', ...data }, update: data });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Google Drive service account
router.post('/drive-service-account', requireAuth, async (req, res, next) => {
  try {
    const { serviceAccountKey } = req.body;
    if (!serviceAccountKey || typeof serviceAccountKey !== 'object') {
      return res.status(400).json({ error: 'Invalid service account JSON' });
    }
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', driveServiceAccountKey: serviceAccountKey },
      update: { driveServiceAccountKey: serviceAccountKey },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/drive-status', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    res.json({ connected: !!(s?.driveServiceAccountKey) });
  } catch (e) { next(e); }
});

router.post('/user', requireAdmin, async (req, res, next) => {
  try {
    const { email, name, role, bizId } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: `${email} already has an account` });

    const inviteToken = randomBytes(32).toString('hex');
    const placeholder = await bcrypt.hash(randomBytes(16).toString('hex'), 10);
    const user = await prisma.user.create({
      data: { email, password: placeholder, name, role: role || 'operator', bizId, inviteToken },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'https://kboos-production.up.railway.app';
    const inviteLink = `${frontendUrl}?invite=${inviteToken}`;

    try {
      const sgKey = await getApiKey('sendgrid');
      if (sgKey) {
        await sendEmail({
          to: email,
          subject: 'You have been invited to KOBIS Outreach OS',
          body: `Hi ${name},\n\nYou've been invited to join the KOBIS Outreach OS team as ${role || 'operator'}.\n\nClick the link below to set your password and activate your account:\n\n${inviteLink}\n\nThis link is unique to you — do not share it.\n\nKOBIS Team`,
        });
      }
    } catch { /* email optional */ }

    res.json({ id: user.id, email: user.email, name: user.name, role: user.role, inviteLink });
  } catch (e) { next(e); }
});

// POST /settings/reply-persona
router.post('/reply-persona', requireAuth, async (req, res, next) => {
  try {
    const { name, role, style, bizId } = req.body;
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const personas = Array.isArray(s?.replyPersonas) ? s.replyPersonas : [];
    const idx = personas.findIndex(p => p.bizId === (bizId || null));
    if (idx >= 0) personas[idx] = { name, role, style, bizId: bizId || null };
    else personas.push({ name, role, style, bizId: bizId || null });
    const updated = await prisma.appSettings.update({ where: { id: 'global' }, data: { replyPersonas: personas } });
    res.json(updated.replyPersonas);
  } catch (e) { next(e); }
});

// POST /settings/reply-goal
router.post('/reply-goal', requireAuth, async (req, res, next) => {
  try {
    const { bizId, goalType, ctaText } = req.body;
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const goals = Array.isArray(s?.replyGoals) ? s.replyGoals : [];
    const idx = goals.findIndex(g => g.bizId === (bizId || null));
    if (idx >= 0) goals[idx] = { bizId: bizId || null, goalType, ctaText };
    else goals.push({ bizId: bizId || null, goalType, ctaText });
    const updated = await prisma.appSettings.update({ where: { id: 'global' }, data: { replyGoals: goals } });
    res.json(updated.replyGoals);
  } catch (e) { next(e); }
});

// GET /settings/auto-reply
router.get('/auto-reply', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    res.json(s?.autoReplyConfig || { enabled: false, mode: 'autopilot', maxReplies: 5 });
  } catch (e) { next(e); }
});

// POST /settings/auto-reply
router.post('/auto-reply', requireAuth, async (req, res, next) => {
  try {
    const { enabled, mode, maxReplies } = req.body;
    const autoReplyConfig = {
      enabled:    !!enabled,
      mode:       mode === 'assist' ? 'assist' : 'autopilot',
      maxReplies: Math.max(1, Math.min(10, parseInt(maxReplies) || 5)),
    };
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', autoReplyConfig },
      update: { autoReplyConfig },
    });
    res.json(autoReplyConfig);
  } catch (e) { next(e); }
});

// GET /settings/report-config
router.get('/report-config', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const notif = s?.notifications || {};
    res.json(notif.weeklyReport || { enabled: false, includeTeam: true });
  } catch (e) { next(e); }
});

// POST /settings/report-config
router.post('/report-config', requireAuth, async (req, res, next) => {
  try {
    const { enabled, includeTeam } = req.body;
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
    const notif = s?.notifications || {};
    const weeklyReport = { enabled: !!enabled, includeTeam: includeTeam !== false };
    const notifications = { ...notif, weeklyReport };
    await prisma.appSettings.upsert({
      where: { id: 'global' },
      create: { id: 'global', notifications },
      update: { notifications },
    });
    res.json(weeklyReport);
  } catch (e) { next(e); }
});

export default router;
