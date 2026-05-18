import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { sendMessage, sendTemplate, testConnection } from '../services/wati.js';
import { getApiKey } from '../services/apiKeys.js';

const router = Router();

router.post('/send', requireAuth, async (req, res, next) => {
  try { res.json(await sendMessage(req.body)); } catch (e) { next(e); }
});

router.post('/send-template', requireAuth, async (req, res, next) => {
  try { res.json(await sendTemplate(req.body)); } catch (e) { next(e); }
});

router.get('/test', requireAuth, async (req, res, next) => {
  try {
    const token = await getApiKey('wati');
    const url = await getApiKey('wati_url');
    if (!token) return res.json({ ok: false, error: 'No token saved' });
    res.json({ ok: await testConnection(token, url) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

export default router;
