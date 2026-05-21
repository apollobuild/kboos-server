import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { generateBrief, generateEmail, generateFromOffer, suggestReply, testConnection } from '../services/claude.js';
import { getApiKey, saveApiKey } from '../services/apiKeys.js';

const router = Router();

router.post('/generate-brief', requireAuth, async (req, res, next) => {
  try { res.json(await generateBrief(req.body)); } catch (e) { next(e); }
});

router.post('/generate-email', requireAuth, async (req, res, next) => {
  try { res.json(await generateEmail(req.body)); } catch (e) { next(e); }
});

router.post('/generate-from-offer', requireAuth, async (req, res, next) => {
  try { res.json(await generateFromOffer(req.body)); } catch (e) { next(e); }
});

router.post('/suggest-reply', requireAuth, async (req, res, next) => {
  try {
    const result = await suggestReply(req.body);
    // suggestReply now returns { reply, stage, escalate } — extract text for backward compat
    const reply = typeof result === 'string' ? result : result.reply;
    res.json({ reply });
  } catch (e) { next(e); }
});

router.get('/test', requireAuth, async (req, res, next) => {
  try {
    const key = await getApiKey('claude');
    if (!key) return res.json({ ok: false, error: 'No key saved' });
    const ok = await testConnection(key);
    res.json({ ok });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

export default router;
