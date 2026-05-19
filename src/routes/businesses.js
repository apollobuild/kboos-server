import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const list = await prisma.business.findMany({ orderBy: { createdAt: 'asc' } });
    const clientCounts = await prisma.user.groupBy({
      by: ['bizId'],
      where: { role: 'client', bizId: { not: null } },
      _count: true,
    });
    const countMap = {};
    clientCounts.forEach(c => { if (c.bizId) countMap[c.bizId] = c._count; });
    res.json(list.map(b => ({ ...b, clientCount: countMap[b.id] || 0 })));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const biz = await prisma.business.create({ data: req.body });
    res.json(biz);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const biz = await prisma.business.update({ where: { id: req.params.id }, data: req.body });
    res.json(biz);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await prisma.business.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
