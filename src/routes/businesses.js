import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const list = await prisma.business.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'asc' } });
    const clientCounts = await prisma.user.groupBy({
      by: ['bizId'],
      where: { role: 'client', bizId: { not: null }, tenantId: tid },
      _count: true,
    });
    const countMap = {};
    clientCounts.forEach(c => { if (c.bizId) countMap[c.bizId] = c._count; });
    res.json(list.map(b => ({ ...b, clientCount: countMap[b.id] || 0 })));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const biz = await prisma.business.create({ data: { ...req.body, tenantId: tid } });
    res.json(biz);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const biz = await prisma.business.update({ where: { id: req.params.id, tenantId: tid }, data: req.body });
    res.json(biz);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    await prisma.business.delete({ where: { id: req.params.id, tenantId: tid } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
