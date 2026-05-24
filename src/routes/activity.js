import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

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
