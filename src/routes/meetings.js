import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

// GET /meetings?bizId=X&campaignId=Y
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { bizId, campaignId } = req.query;
    const where = {};
    if (bizId) where.bizId = bizId;
    if (campaignId) where.campaignId = parseInt(campaignId);
    const meetings = await prisma.meetingLog.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json(meetings);
  } catch (e) { next(e); }
});

// POST /meetings
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { leadId, campaignId, bizId, meetingDate, meetingType, notes } = req.body;
    if (!leadId) return res.status(400).json({ error: 'leadId required' });

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    const campaign = campaignId ? await prisma.campaign.findUnique({ where: { id: campaignId } }) : null;
    const resolvedBizId = bizId || campaign?.bizId || lead?.bizId;

    const meeting = await prisma.meetingLog.create({
      data: {
        leadId,
        campaignId: campaignId || lead?.campaignId || 0,
        bizId: resolvedBizId || '',
        meetingDate: meetingDate ? new Date(meetingDate) : null,
        meetingType: meetingType || 'discovery',
        notes: notes || '',
        outcome: 'booked',
      },
    });

    // Mark lead as meeting_booked
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'meeting_booked', meetingBooked: true } });

    res.json(meeting);
  } catch (e) { next(e); }
});

// PATCH /meetings/:id
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { outcome, notes, revenue, meetingDate, closedAt } = req.body;
    const update = {};
    if (outcome) update.outcome = outcome;
    if (notes !== undefined) update.notes = notes;
    if (revenue !== undefined) update.revenue = revenue;
    if (meetingDate) update.meetingDate = new Date(meetingDate);
    if (closedAt) update.closedAt = new Date(closedAt);

    const meeting = await prisma.meetingLog.update({ where: { id }, data: update });

    // If deal closed, update lead
    if (outcome === 'completed' && revenue) {
      await prisma.lead.update({ where: { id: meeting.leadId }, data: { dealValue: revenue, dealClosedAt: new Date() } });
    }

    res.json(meeting);
  } catch (e) { next(e); }
});

// GET /meetings/revenue?bizId=X&campaignId=Y
router.get('/revenue', requireAuth, async (req, res, next) => {
  try {
    const { bizId, campaignId } = req.query;
    const where = {};
    if (bizId) where.bizId = bizId;
    if (campaignId) where.campaignId = parseInt(campaignId);

    const meetings = await prisma.meetingLog.findMany({ where });
    const leads = campaignId
      ? await prisma.lead.findMany({ where: { campaignId: parseInt(campaignId) }, select: { status: true, dealValue: true } })
      : await prisma.lead.findMany({ where: bizId ? { bizId } : {}, select: { status: true, dealValue: true } });

    const summary = {
      totalMeetings: meetings.length,
      bookedMeetings: meetings.filter(m => m.outcome === 'booked').length,
      completedMeetings: meetings.filter(m => m.outcome === 'completed').length,
      cancelledMeetings: meetings.filter(m => m.outcome === 'cancelled').length,
      totalRevenue: meetings.reduce((sum, m) => sum + (m.revenue || 0), 0),
      hotLeads: leads.filter(l => l.status === 'hot').length,
      meetingBookedLeads: leads.filter(l => l.status === 'meeting_booked').length,
      closedDeals: leads.filter(l => l.dealValue).length,
      totalDealValue: leads.reduce((sum, l) => sum + (l.dealValue || 0), 0),
    };

    res.json(summary);
  } catch (e) { next(e); }
});

// DELETE /meetings/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.meetingLog.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
