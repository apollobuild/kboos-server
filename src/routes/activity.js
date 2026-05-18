import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.activity.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })); } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.activity.create({ data: req.body })); } catch (e) { next(e); }
});

export default router;
