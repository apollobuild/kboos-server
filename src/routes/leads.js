import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const where = req.query.campaignId ? { campaignId: parseInt(req.query.campaignId) } : {};
    res.json(await prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' } }));
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.lead.create({ data: req.body })); } catch (e) { next(e); }
});

router.patch('/bulk', requireAuth, async (req, res, next) => {
  try {
    const { ids, patch } = req.body;
    await prisma.lead.updateMany({ where: { id: { in: ids } }, data: patch });
    res.json({ ok: true, count: ids.length });
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const lead = await prisma.lead.update({ where: { id: parseInt(req.params.id) }, data: req.body });
    if (req.body.status) {
      const colorMap = { hot:'amber', meeting_booked:'green', replied:'blue', unsubscribed:'red', bounced:'red' };
      await prisma.activity.create({ data: {
        color: colorMap[req.body.status] || 'blue',
        msg: `${lead.name} (${lead.company}) marked as ${req.body.status.replace(/_/g, ' ')}`,
        tag: 'Leads',
      }}).catch(() => {});
    }
    res.json(lead);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try { await prisma.lead.delete({ where: { id: parseInt(req.params.id) } }); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
