import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { sendTemplateMessage, sendTextMessage, getTemplates, testConnection, buildComponents } from '../services/metaWa.js';
import { getApiKey } from '../services/apiKeys.js';
import prisma from '../db.js';

const router = Router();
// ── Phone Number CRUD ──

// GET /meta-wa/numbers
router.get('/numbers', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId || 'default';
    const numbers = await prisma.metaWANumber.findMany({
      where: { tenantId: tid },
      orderBy: { createdAt: 'asc' },
    });
    res.json(numbers);
  } catch (e) { next(e); }
});

// POST /meta-wa/numbers — add a new number
router.post('/numbers', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId || 'default';
    const { label, phoneNumberId, dailyLimit = 1000 } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: 'Label is required' });
    if (!phoneNumberId?.trim()) return res.status(400).json({ error: 'Phone Number ID is required' });
    const num = await prisma.metaWANumber.create({
      data: { tenantId: tid, label: label.trim(), phoneNumberId: phoneNumberId.trim(), dailyLimit: parseInt(dailyLimit) || 1000 },
    });
    res.json(num);
  } catch (e) { next(e); }
});

// PATCH /meta-wa/numbers/:id
router.patch('/numbers/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { label, phoneNumberId, dailyLimit, active } = req.body;
    const data = {};
    if (label !== undefined) data.label = label.trim();
    if (phoneNumberId !== undefined) data.phoneNumberId = phoneNumberId.trim();
    if (dailyLimit !== undefined) data.dailyLimit = parseInt(dailyLimit);
    if (active !== undefined) data.active = active;
    const num = await prisma.metaWANumber.update({ where: { id }, data });
    res.json(num);
  } catch (e) { next(e); }
});

// DELETE /meta-wa/numbers/:id
router.delete('/numbers/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.metaWANumber.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /meta-wa/numbers/:id/test — test a specific number
router.post('/numbers/:id/test', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const num = await prisma.metaWANumber.findUnique({ where: { id } });
    if (!num) return res.status(404).json({ error: 'Number not found' });
    const result = await testConnection(num.phoneNumberId);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /meta-wa/templates — list approved Meta templates
router.get('/templates', requireAuth, async (req, res, next) => {
  try {
    const templates = await getTemplates();
    res.json(templates);
  } catch (e) { next(e); }
});

// POST /meta-wa/test — verify credentials work
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    const result = await testConnection();
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /meta-wa/send — send single template message
router.post('/send', requireAuth, async (req, res, next) => {
  try {
    const { to, templateName, languageCode, components } = req.body;
    if (!to || !templateName) return res.status(400).json({ error: 'to and templateName required' });
    const result = await sendTemplateMessage({ to, templateName, languageCode: languageCode || 'en', components: components || [] });
    res.json(result);
  } catch (e) { next(e); }
});

// POST /meta-wa/send-bulk — send template to campaign leads
router.post('/send-bulk', requireAuth, async (req, res, next) => {
  try {
    const { campaignId, templateName, languageCode = 'en', varMap = {}, leads: leadList } = req.body;
    if (!templateName) return res.status(400).json({ error: 'templateName required' });

    // Use provided leads or load from campaign
    let leads = leadList;
    if (!leads && campaignId) {
      leads = await prisma.lead.findMany({
        where: { campaignId: parseInt(campaignId), status: { notIn: ['unsubscribed', 'bounced'] } },
        select: { id: true, name: true, company: true, title: true, phone: true, email: true },
      });
    }
    if (!leads?.length) return res.status(400).json({ error: 'No leads provided' });

    const results = { sent: 0, failed: 0, errors: [] };

    // Send with 500ms gap between messages to respect rate limits
    for (const lead of leads) {
      if (!lead.phone) { results.failed++; continue; }
      try {
        const components = buildComponents(varMap, lead);
        await sendTemplateMessage({ to: lead.phone, templateName, languageCode, components });
        results.sent++;
        if (campaignId) {
          await prisma.lead.update({ where: { id: lead.id }, data: { status: 'contacted', last: 'just now' } }).catch(() => {});
        }
      } catch (e) {
        results.failed++;
        results.errors.push({ lead: lead.name, error: e.message });
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (campaignId) {
      await prisma.activity.create({
        data: { color: 'green', msg: `Meta WA: sent ${results.sent} messages via template "${templateName}"`, tag: 'WhatsApp' },
      }).catch(() => {});
    }

    res.json(results);
  } catch (e) { next(e); }
});

// GET /webhooks/meta-wa — webhook verification (Meta calls this to verify)
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const secret = process.env.META_WA_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || 'kboos-webhook';
  if (mode === 'subscribe' && token === secret) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST /webhooks/meta-wa — receive inbound messages and delivery receipts
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always ack immediately
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value;
        // Delivery receipts / status updates
        for (const status of (value.statuses || [])) {
          console.log(`[MetaWA] Status: ${status.id} → ${status.status}`);
        }
        // Inbound messages
        for (const msg of (value.messages || [])) {
          const from = msg.from;
          const text = msg.text?.body || msg.button?.text || '[non-text]';
          console.log(`[MetaWA] Inbound from ${from}: ${text}`);
          // Store as reply
          await prisma.reply.create({
            data: {
              name: value.contacts?.[0]?.profile?.name || from,
              company: '',
              channel: 'whatsapp',
              msg: text,
              status: 'unread',
              phone: from,
            },
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error('[MetaWA] Webhook error:', e.message);
  }
});

export default router;
