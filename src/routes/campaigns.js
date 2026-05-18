import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.campaign.findMany({ orderBy: { createdAt: 'asc' } })); } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.campaign.create({ data: req.body })); } catch (e) { next(e); }
});

router.patch('/:id/toggle', requireAuth, async (req, res, next) => {
  try {
    const c = await prisma.campaign.findUnique({ where: { id: parseInt(req.params.id) } });
    const next_status = c.status === 'active' ? 'paused' : 'active';
    const updated = await prisma.campaign.update({ where: { id: c.id }, data: { status: next_status } });
    await prisma.activity.create({ data: {
      color: next_status === 'active' ? 'green' : 'amber',
      msg: `Campaign "${c.name}" ${next_status === 'active' ? 'resumed' : 'paused'}`,
      tag: 'Campaigns',
    }}).catch(() => {});
    res.json(updated);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.campaign.update({ where: { id: parseInt(req.params.id) }, data: req.body })); } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try { await prisma.campaign.delete({ where: { id: parseInt(req.params.id) } }); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
