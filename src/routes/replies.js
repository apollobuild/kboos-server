import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { suggestReply } from '../services/claude.js';
import { sendMessage } from '../services/wati.js';
import { sendEmail } from '../services/sendgrid.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.reply.findMany({ orderBy: { createdAt: 'desc' } })); } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.reply.update({ where: { id: parseInt(req.params.id) }, data: req.body })); } catch (e) { next(e); }
});

// Generate AI draft — stores in DB, returns it
router.post('/:id/generate-draft', requireAuth, async (req, res, next) => {
  try {
    const reply = await prisma.reply.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } }).catch(() => null);
    const personas = settings?.replyPersonas || [];
    const goals    = settings?.replyGoals    || [];

    // Find persona and goal for this business
    const persona = personas.find(p => p.bizId === reply.bizId) || personas[0] || {};
    const goal    = goals.find(g => g.bizId === reply.bizId)?.ctaText || '';

    // Get business name
    let bizName = '';
    if (reply.bizId) {
      const biz = await prisma.business.findUnique({ where: { id: reply.bizId } }).catch(() => null);
      bizName = biz?.name || '';
    }

    const thread = Array.isArray(reply.thread) ? reply.thread : [];
    const result = await suggestReply({
      message:    reply.msg,
      senderName: reply.name,
      company:    reply.company,
      channel:    reply.channel,
      isHot:      reply.hot,
      isUnsub:    reply.unsub,
      thread,
      persona,
      goal,
      bizName,
      stage: reply.aiStage || 'cold',
    });

    // Store draft + updated stage in DB
    await prisma.reply.update({
      where: { id: reply.id },
      data: {
        aiDraft:    result.reply,
        aiStage:    result.stage || reply.aiStage,
        aiEscalate: result.escalate || false,
      },
    });

    res.json(result);
  } catch (e) { next(e); }
});

// Send the draft (or a manually edited version) — adds to thread, marks handled
router.post('/:id/send-draft', requireAuth, async (req, res, next) => {
  try {
    const { message } = req.body;
    const reply = await prisma.reply.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    const lead = reply.leadId ? await prisma.lead.findUnique({ where: { id: reply.leadId } }).catch(() => null) : null;

    const ch = (reply.channel || '').toLowerCase();
    const isWA = ch === 'wa' || ch === 'whatsapp';

    // Append inbound + outbound to thread
    const thread = Array.isArray(reply.thread) ? reply.thread : [];
    // Add the original inbound message if not already in thread
    const alreadyHasInbound = thread.some(t => t.role === 'lead' && t.content === reply.msg);
    if (!alreadyHasInbound) {
      thread.push({ role: 'lead', content: reply.msg, ts: reply.createdAt, channel: reply.channel });
    }
    thread.push({ role: 'agent', content: message, ts: new Date().toISOString(), channel: reply.channel, sentVia: 'human' });

    // Send
    let sendOk = false;
    try {
      if (isWA && lead?.phone) {
        await sendMessage({ phone: lead.phone, message });
        sendOk = true;
      } else if (!isWA && lead?.email) {
        await sendEmail({ to: lead.email, subject: 'Re: Your inquiry', body: message });
        sendOk = true;
      }
    } catch { /* already handled — still update DB */ }

    await prisma.reply.update({
      where: { id: reply.id },
      data: {
        thread,
        aiDraft: null,
        status: 'handled',
      },
    });

    // Log activity
    await prisma.activity.create({
      data: { color: 'blue', msg: `AI reply sent to ${reply.name} at ${reply.company} via ${reply.channel}`, tag: 'Reply' },
    }).catch(() => {});

    res.json({ ok: true, sent: sendOk });
  } catch (e) { next(e); }
});

export default router;
