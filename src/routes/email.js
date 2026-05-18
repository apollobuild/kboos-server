import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { sendEmail, sendBulk, testConnection } from '../services/sendgrid.js';
import { getApiKey } from '../services/apiKeys.js';

const router = Router();

router.post('/send', requireAuth, async (req, res, next) => {
  try { res.json(await sendEmail(req.body)); } catch (e) { next(e); }
});

router.post('/send-bulk', requireAuth, async (req, res, next) => {
  try { res.json(await sendBulk(req.body.leads, req.body.subject, req.body.template, req.body.fromEmail)); } catch (e) { next(e); }
});

router.get('/test', requireAuth, async (req, res, next) => {
  try {
    const key = await getApiKey('sendgrid');
    if (!key) return res.json({ ok: false, error: 'No key saved' });
    res.json({ ok: await testConnection(key) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

export default router;
