import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.get('/:id/actions', requireAuth, async (req, res, next) => {
  try {
    const actions = await prisma.campaignAction.findMany({
      where: { leadId: parseInt(req.params.id) },
      orderBy: { sentAt: 'asc' },
    });
    res.json(actions);
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (e) { next(e); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const where = req.query.campaignId ? { campaignId: parseInt(req.query.campaignId) } : {};
    res.json(await prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' } }));
  } catch (e) { next(e); }
});

router.post('/bulk-import', requireAuth, async (req, res, next) => {
  try {
    const { campaignId, leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) return res.status(400).json({ error: 'No leads provided' });
    const data = leads.map(l => ({
      campaignId: campaignId ? parseInt(campaignId) : null,
      name:    (l.name || l.Name || l.full_name || '').trim() || 'Unknown',
      company: (l.company || l.Company || l.organization || '').trim() || '',
      title:   (l.title || l.Title || l.job_title || '').trim() || '',
      email:   (l.email || l.Email || '').trim() || null,
      phone:   (l.phone || l.Phone || l.mobile || '').trim() || null,
      status:  'new',
      score:   0,
      lang:    'EN',
      channels: [],
    }));
    const created = await prisma.lead.createMany({ data, skipDuplicates: true });
    if (campaignId) {
      await prisma.campaign.update({ where: { id: parseInt(campaignId) }, data: { leads: { increment: created.count } } }).catch(() => {});
    }
    res.json({ ok: true, count: created.count });
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try { res.json(await prisma.lead.create({ data: req.body })); } catch (e) { next(e); }
});

router.patch('/bulk', requireAuth, async (req, res, next) => {
  try {
    const { ids, patch } = req.body;
    await prisma.lead.updateMany({ where: { id: { in: ids } }, data: patch });
    res.json({ ok: true, count: ids.length });
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const lead = await prisma.lead.update({ where: { id: parseInt(req.params.id) }, data: req.body });
    if (req.body.status) {
      const colorMap = { hot:'amber', meeting_booked:'green', replied:'blue', unsubscribed:'red', bounced:'red' };
      await prisma.activity.create({ data: {
        color: colorMap[req.body.status] || 'blue',
        msg: `${lead.name} (${lead.company}) marked as ${req.body.status.replace(/_/g, ' ')}`,
        tag: 'Leads',
      }}).catch(() => {});

      // Track opens/replies against the currently active template
      if (['opened', 'replied', 'hot'].includes(req.body.status)) {
        const statKey = req.body.status === 'opened' ? 'opens' : 'replies';
        const s = await prisma.appSettings.findUnique({ where: { id: 'global' } }).catch(() => null);
        if (s?.promptTemplates?.length) {
          const active = s.promptTemplates.find(t => t.active);
          if (active) {
            const updated = s.promptTemplates.map(t => t.id === active.id
              ? { ...t, stats: { opens: 0, replies: 0, ...(t.stats || {}), [statKey]: ((t.stats?.[statKey] || 0) + 1) } }
              : t
            );
            await prisma.appSettings.update({ where: { id: 'global' }, data: { promptTemplates: updated } }).catch(() => {});
          }
        }
      }
    }
    res.json(lead);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try { await prisma.lead.delete({ where: { id: parseInt(req.params.id) } }); res.json({ ok: true }); } catch (e) { next(e); }
});

export default router;
