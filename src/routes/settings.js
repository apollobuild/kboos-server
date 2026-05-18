import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { saveApiKey, getApiKey } from '../services/apiKeys.js';
import { testConnection as testClaude } from '../services/claude.js';
import { testConnection as testSendGrid, sendEmail } from '../services/sendgrid.js';
import { testConnection as testWati } from '../services/wati.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.appSettings.findUnique({ where: { id: 'global' } }) || {};
    // Mask key values
    const keys = {};
    for (const api of ['claude', 'sendgrid', 'wati', 'wati_url', 'apollo', 'billplz_api_key', 'billplz_collection_id', 'billplz_x_signature_key']) {
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
      select: { id: true, email: true, name: true, role: true, createdAt: true, inviteToken: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map(u => ({ ...u, pending: !!u.inviteToken, inviteToken: undefined })));
  } catch (e) { next(e); }
});

router.delete('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
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

export default router;
