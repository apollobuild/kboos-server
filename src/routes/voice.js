import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { makeCall, getCallStatus } from '../services/vapi.js';

const router = Router();
const prisma = new PrismaClient();

// POST /voice/call — trigger Vapi call for a lead
router.post('/call', requireAuth, async (req, res, next) => {
  try {
    const { leadId, campaignScript } = req.body;
    if (!leadId) return res.status(400).json({ error: 'leadId required' });

    const lead = await prisma.lead.findUnique({ where: { id: parseInt(leadId) } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number' });

    const campaign = lead.campaignId
      ? await prisma.campaign.findUnique({ where: { id: lead.campaignId } })
      : null;

    const call = await makeCall({
      phone: lead.phone,
      leadName: lead.name,
      bizName: campaign?.bizName || 'our company',
      campaignScript,
    });

    // Update lead status
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'call_initiated', last: 'just now' },
    });

    await prisma.activity.create({
      data: {
        color: 'purple',
        msg: `AI voice call placed to ${lead.name} (${lead.company})`,
        tag: 'Voice',
      },
    }).catch(() => {});

    res.json({ ok: true, callId: call.id, status: call.status });
  } catch (e) { next(e); }
});

// GET /voice/call/:id — get call status + transcript
router.get('/call/:id', requireAuth, async (req, res, next) => {
  try {
    const call = await getCallStatus(req.params.id);
    res.json({
      status: call.status,
      duration: call.endedAt ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) : null,
      transcript: call.artifact?.transcript || null,
      recordingUrl: call.artifact?.recordingUrl || null,
    });
  } catch (e) { next(e); }
});

export default router;
