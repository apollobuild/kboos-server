import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
router.get('/:id/actions', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const actions = await prisma.campaignAction.findMany({
      where: { leadId: parseInt(req.params.id), tenantId: tid },
      orderBy: { sentAt: 'asc' },
    });
    res.json(actions);
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const lead = await prisma.lead.findUnique({ where: { id: parseInt(req.params.id), tenantId: tid } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (e) { next(e); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const where = req.query.campaignId
      ? { campaignId: parseInt(req.query.campaignId), tenantId: tid }
      : { tenantId: tid };
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const offset = parseInt(req.query.offset) || 0;
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.lead.count({ where }),
    ]);
    res.json({ leads, total, limit, offset });
  } catch (e) { next(e); }
});

router.post('/bulk-import', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const { campaignId, leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) return res.status(400).json({ error: 'No leads provided' });
    const data = leads.map(l => ({
      campaignId: campaignId ? parseInt(campaignId) : null,
      tenantId: tid,
      name:    (l.name || l.Name || l.full_name || '').trim() || 'Unknown',
      company: (l.company || l.Company || l.organization || '').trim() || '',
      title:   (l.title || l.Title || l.job_title || '').trim() || '',
      email:   (l.email || l.Email || '').trim() || '',
      phone:   (l.phone || l.Phone || l.mobile || '').trim() || '',
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
  try {
    const tid = req.user.tenantId;
    res.json(await prisma.lead.create({ data: { ...req.body, tenantId: tid } }));
  } catch (e) { next(e); }
});

router.patch('/bulk', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const { ids, patch } = req.body;
    await prisma.lead.updateMany({ where: { id: { in: ids }, tenantId: tid }, data: patch });
    res.json({ ok: true, count: ids.length });
  } catch (e) { next(e); }
});

// PATCH /leads/bulk-assign — reassign leads to a different campaign
router.patch('/bulk-assign', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const { ids, campaignId } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });

    const campaign = await prisma.campaign.findUnique({ where: { id: parseInt(campaignId), tenantId: tid } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.lead.updateMany({
      where: { id: { in: ids.map(Number) }, tenantId: tid },
      data: { campaignId: parseInt(campaignId), bizId: campaign.bizId, status: 'new' },
    });

    const newTotal = await prisma.lead.count({ where: { campaignId: parseInt(campaignId), tenantId: tid } });
    await prisma.campaign.update({ where: { id: parseInt(campaignId) }, data: { leads: newTotal } });
    await prisma.activity.create({ data: { color: 'blue', msg: `${ids.length} leads assigned to "${campaign.name}"`, tag: 'Leads', tenantId: tid } }).catch(() => {});

    res.json({ ok: true, count: ids.length });
  } catch (e) { next(e); }
});

// POST /leads/bulk-enrich — enrich leads via Apollo (fills email, title, phone)
router.post('/bulk-enrich', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

    const { enrichLead } = await import('../services/apollo.js');
    const leads = await prisma.lead.findMany({
      where: { id: { in: ids.map(Number) }, tenantId: tid },
      select: { id: true, company: true, address: true, email: true, title: true, phone: true },
    });

    let enriched = 0;
    const BATCH = 5;
    for (let i = 0; i < leads.length; i += BATCH) {
      await Promise.allSettled(leads.slice(i, i + BATCH).map(async lead => {
        if (!lead.company) return;
        const city = lead.address?.split(',')[0]?.trim() || null;
        const result = await enrichLead({ companyName: lead.company, city }).catch(() => null);
        if (!result) return;
        const patch = { enriched: true };
        if (!lead.email  && result.email) patch.email = result.email;
        if (!lead.title  && result.title) patch.title = result.title;
        if (!lead.phone  && result.phone) {
          patch.phone = result.phone;
          patch.channels = { push: 'whatsapp' };
        }
        await prisma.lead.update({ where: { id: lead.id }, data: patch });
        enriched++;
      }));
    }

    res.json({ enriched, total: leads.length });
  } catch (e) { next(e); }
});

// DELETE /leads/bulk — delete multiple leads by id
router.delete('/bulk', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    await prisma.lead.deleteMany({ where: { id: { in: ids.map(Number) }, tenantId: tid } });
    res.json({ ok: true, count: ids.length });
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const tid = req.user.tenantId;
    const lead = await prisma.lead.update({ where: { id: parseInt(req.params.id), tenantId: tid }, data: req.body });
    if (req.body.status) {
      const colorMap = { hot:'amber', meeting_booked:'green', replied:'blue', unsubscribed:'red', bounced:'red' };
      await prisma.activity.create({ data: {
        color: colorMap[req.body.status] || 'blue',
        msg: `${lead.name} (${lead.company}) marked as ${req.body.status.replace(/_/g, ' ')}`,
        tag: 'Leads',
        tenantId: tid,
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
  try {
    const tid = req.user.tenantId;
    await prisma.lead.delete({ where: { id: parseInt(req.params.id), tenantId: tid } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
