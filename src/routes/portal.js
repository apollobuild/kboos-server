import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
// GET /portal/data — returns all data for a client's business
// Clients use their own bizId from JWT; admins can pass ?bizId= to preview
router.get('/data', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const bizId = req.user.role === 'client' ? req.user.bizId : req.query.bizId;
    if (!bizId) return res.status(400).json({ error: 'No business assigned to this account' });

    const [biz, campaigns, hotLeads, activity] = await Promise.all([
      prisma.business.findFirst({ where: { id: bizId, tenantId: tid } }),
      prisma.campaign.findMany({ where: { bizId, tenantId: tid }, orderBy: { createdAt: 'desc' } }),
      prisma.lead.findMany({
        where: { bizId, tenantId: tid, status: { in: ['hot', 'replied'] } },
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        take: 100,
      }),
      prisma.activity.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);

    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const leadIds = hotLeads.map(l => l.id).filter(Boolean);
    const replies = leadIds.length > 0
      ? await prisma.reply.findMany({
          where: { leadId: { in: leadIds }, tenantId: tid, unsub: false },
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
    const tid = req.user.tenantId;
    const leadId = Number(req.params.id);
    const { clientStatus } = req.body;
    const allowed = ['', 'contacted', 'meeting_booked', 'closed_won', 'not_interested'];
    if (!allowed.includes(clientStatus)) return res.status(400).json({ error: 'Invalid status' });

    // Verify lead belongs to this tenant before updating
    const existing = await prisma.lead.findFirst({ where: { id: leadId, tenantId: tid } });
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { clientStatus },
    });
    res.json(lead);
  } catch (e) { next(e); }
});

export default router;
