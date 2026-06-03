import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    res.json(await prisma.activity.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, take: 50 }));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    res.json(await prisma.activity.create({ data: { ...req.body, tenantId: tid } }));
  } catch (e) { next(e); }
});

export default router;
