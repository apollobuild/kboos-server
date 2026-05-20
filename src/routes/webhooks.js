import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// POST /webhooks/sendgrid
router.post('/sendgrid', async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      const email = event.email;
      if (!email) continue;
      const lead = await prisma.lead.findFirst({ where: { email }, select: { id: true, status: true } }).catch(() => null);
      if (!lead) continue;

      if (event.event === 'open' && !['replied', 'hot', 'meeting_booked'].includes(lead.status)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'opened' } }).catch(() => {});
        await prisma.campaignAction.updateMany({
          where: { leadId: lead.id, type: 'email', status: 'sent', openedAt: null },
          data: { openedAt: new Date(), status: 'opened' },
        }).catch(() => {});
      }
      if (['bounce', 'dropped'].includes(event.event)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'bounced' } }).catch(() => {});
      }
      if (['unsubscribe', 'group_unsubscribe'].includes(event.event)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'unsubscribed' } }).catch(() => {});
        await prisma.reply.create({
          data: { leadId: lead.id, name: email, company: '', channel: 'email', msg: 'Unsubscribed via email', unsub: true, status: 'read' },
        }).catch(() => {});
      }
    }
  } catch { /* always 200 */ }
  res.sendStatus(200);
});

// POST /webhooks/wati
router.post('/wati', async (req, res) => {
  try {
    const event = req.body;
    const rawPhone = event.waId || event.phone || event.from || '';
    if (!rawPhone) return res.sendStatus(200);

    const digits = rawPhone.replace(/\D/g, '').slice(-9);
    const lead = await prisma.lead.findFirst({
      where: { phone: { contains: digits } },
      select: { id: true, status: true, name: true, company: true },
    }).catch(() => null);
    if (!lead) return res.sendStatus(200);

    const eventType = event.eventType || event.type || '';

    if (eventType === 'optOut' || eventType === 'opt_out' || event.isOptOut) {
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'unsubscribed' } }).catch(() => {});
      await prisma.reply.create({
        data: { leadId: lead.id, name: lead.name, company: lead.company, channel: 'whatsapp', msg: 'Opted out of WhatsApp', unsub: true, status: 'read' },
      }).catch(() => {});
    }

    if (eventType === 'message' && (event.text || event.body)) {
      const msg = event.text || event.body;
      await prisma.reply.create({
        data: { leadId: lead.id, name: lead.name, company: lead.company, channel: 'whatsapp', msg, status: 'unread' },
      }).catch(() => {});
      if (!['replied', 'hot', 'meeting_booked', 'unsubscribed'].includes(lead.status)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { status: 'replied' } }).catch(() => {});
      }
    }
  } catch { /* always 200 */ }
  res.sendStatus(200);
});

export default router;
