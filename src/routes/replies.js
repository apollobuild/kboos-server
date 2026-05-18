import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.reply.findMany({ orderBy: { createdAt: 'desc' } })); } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.reply.update({ where: { id: parseInt(req.params.id) }, data: req.body })); } catch (e) { next(e); }
});

export default router;
