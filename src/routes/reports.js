import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { enqueue } from '../services/queue.js';
import { buildReportData, buildHtml } from '../workers/weeklyReport.js';

const router = Router();
const prisma = new PrismaClient();

// POST /reports/send-now/:bizId — manually trigger report for one business
router.post('/send-now/:bizId', requireAuth, async (req, res, next) => {
  try {
    const { bizId } = req.params;
    await enqueue('weekly-report', { bizId, force: true });
    res.json({ ok: true, queued: true });
  } catch (e) { next(e); }
});

// POST /reports/send-all — trigger for all businesses with client users
router.post('/send-all', requireAuth, async (req, res, next) => {
  try {
    const bizIds = await prisma.user.findMany({
      where: { role: 'client', bizId: { not: null } },
      select: { bizId: true },
      distinct: ['bizId'],
    });
    for (const { bizId } of bizIds) {
      await enqueue('weekly-report', { bizId, force: true }).catch(() => {});
    }
    res.json({ ok: true, queued: bizIds.length });
  } catch (e) { next(e); }
});

// GET /reports/preview/:bizId — returns HTML preview (for iframe)
router.get('/preview/:bizId', requireAuth, async (req, res, next) => {
  try {
    const data = await buildReportData(req.params.bizId);
    if (!data) return res.status(404).json({ error: 'Business not found' });
    const html = buildHtml(data);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) { next(e); }
});

export default router;
