import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

// GET /portal/data — returns all data for a client's business
// Clients use their own bizId from JWT; admins can pass ?bizId= to preview
router.get('/data', requireAuth, async (req, res, next) => {
  try {
    const bizId = req.user.role === 'client' ? req.user.bizId : req.query.bizId;
    if (!bizId) return res.status(400).json({ error: 'No business assigned to this account' });

    const [biz, campaigns, hotLeads, activity] = await Promise.all([
      prisma.business.findUnique({ where: { id: bizId } }),
      prisma.campaign.findMany({ where: { bizId }, orderBy: { createdAt: 'desc' } }),
      prisma.lead.findMany({
        where: { bizId, status: { in: ['hot', 'replied'] } },
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        take: 100,
      }),
      prisma.activity.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);

    if (!biz) return res.status(404).json({ error: 'Business not found' });

    // Attach latest reply message to each hot lead
    const leadIds = hotLeads.map(l => l.id).filter(Boolean);
    const replies = leadIds.length > 0
      ? await prisma.reply.findMany({
          where: { leadId: { in: leadIds }, unsub: false },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const latestReplyByLeadId = {};
    for (const r of replies) {
      if (r.leadId && !latestReplyByLeadId[r.leadId]) {
        latestReplyByLeadId[r.leadId] = r;
      }
    }

    const enrichedLeads = hotLeads.map(l => ({
      ...l,
      latestReply: latestReplyByLeadId[l.id] || null,
    }));

    res.json({ biz, campaigns, hotLeads: enrichedLeads, activity });
  } catch (e) { next(e); }
});

// PATCH /portal/leads/:id — client updates their tracking status for a lead
router.patch('/leads/:id', requireAuth, async (req, res, next) => {
  try {
    const { clientStatus } = req.body;
    const allowed = ['', 'contacted', 'meeting_booked', 'closed_won', 'not_interested'];
    if (!allowed.includes(clientStatus)) return res.status(400).json({ error: 'Invalid status' });
    const lead = await prisma.lead.update({
      where: { id: Number(req.params.id) },
      data: { clientStatus },
    });
    res.json(lead);
  } catch (e) { next(e); }
});

export default router;
