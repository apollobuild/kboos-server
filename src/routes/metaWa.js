import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { sendTemplateMessage, sendTextMessage, getTemplates, testConnection, buildComponents } from '../services/metaWa.js';
import prisma from '../db.js';

const router = Router();
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
