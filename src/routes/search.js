import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
// GET /search?q=xxx — search across leads, businesses, campaigns, replies
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ leads: [], businesses: [], campaigns: [], replies: [] });

    const tid = req.user.tenantId;
    const ci = { contains: q, mode: 'insensitive' };

    const [leads, businesses, campaigns, replies] = await Promise.all([
      prisma.lead.findMany({
        where: { tenantId: tid, OR: [{ name: ci }, { company: ci }, { email: ci }, { phone: { contains: q } }] },
        select: { id: true, name: true, company: true, title: true, status: true, score: true, email: true, bizId: true, campaignId: true },
        take: 6,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.business.findMany({
        where: { tenantId: tid, OR: [{ name: ci }, { industry: ci }] },
        select: { id: true, name: true, industry: true, color: true },
        take: 4,
      }),
      prisma.campaign.findMany({
        where: { tenantId: tid, OR: [{ name: ci }, { bizName: ci }] },
        select: { id: true, name: true, bizName: true, status: true, color: true },
        take: 4,
      }),
      prisma.reply.findMany({
        where: { tenantId: tid, OR: [{ name: ci }, { company: ci }, { msg: ci }] },
        select: { id: true, name: true, company: true, channel: true, msg: true, status: true, leadId: true, createdAt: true },
        take: 4,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({ leads, businesses, campaigns, replies });
  } catch (e) { next(e); }
});

export default router;
