import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { makeCall, getCallStatus } from '../services/vapi.js';
import { getApiKey } from '../services/apiKeys.js';
import prisma from '../db.js';

const router = Router();
// GET /voice/phone-numbers — list phone numbers from Vapi
router.get('/phone-numbers', requireAuth, async (req, res, next) => {
  try {
    const key = await getApiKey('vapi');
    if (!key) return res.status(400).json({ error: 'Vapi API key not configured. Save it in Settings → API Keys first.' });
    const r = await fetch('https://api.vapi.ai/phone-number', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => 'Unknown error');
      return res.status(r.status).json({ error: `Vapi error: ${msg}` });
    }
    const numbers = await r.json();
    res.json(numbers.map(n => ({
      id: n.id,
      number: n.number || n.twilioPhoneNumber || n.vonagePhoneNumber || '(no number)',
      name: n.name || null,
      provider: n.provider || (n.twilioPhoneNumber ? 'twilio' : n.vonagePhoneNumber ? 'vonage' : 'vapi'),
    })));
  } catch (e) { next(e); }
});

// POST /voice/call — trigger Vapi call for a lead
router.post('/call', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const { leadId, campaignScript } = req.body;
    if (!leadId) return res.status(400).json({ error: 'leadId required' });

    const lead = await prisma.lead.findFirst({ where: { id: parseInt(leadId), tenantId: tid } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number' });

    const campaign = lead.campaignId
      ? await prisma.campaign.findFirst({ where: { id: lead.campaignId, tenantId: tid } })
      : null;

    const call = await makeCall({
      phone: lead.phone,
      leadName: lead.name,
      bizName: campaign?.bizName || 'our company',
      campaignScript,
    });

    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'call_initiated', last: 'just now' },
    });

    await prisma.activity.create({
      data: {
        color: 'purple',
        msg: `AI voice call placed to ${lead.name} (${lead.company})`,
        tag: 'Voice',
        tenantId: tid,
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
