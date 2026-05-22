import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { enqueue, enqueueBatch } from '../services/queue.js';

const router = Router();
const prisma = new PrismaClient();

// GET /pipeline/:campaignId — full pipeline status
router.get('/:campaignId', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const assetCount = await prisma.campaignAsset.count({ where: { campaignId } });
    const approvedAssets = await prisma.campaignAsset.count({ where: { campaignId, approved: true } });
    const personalizedLeads = await prisma.lead.count({ where: { campaignId, personalized: true } });
    const totalLeads = await prisma.lead.count({ where: { campaignId } });

    res.json({ campaign, pipeline: pipeline || { campaignId, stage: 'draft' }, assetCount, approvedAssets, personalizedLeads, totalLeads });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/scrape — trigger Google Maps / Apollo scrape via queue
router.post('/:campaignId/scrape', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const { mode = 'gmaps', keyword, city, limit = 50, jobTitles = [], seniority = [] } = req.body;

    if (!city) return res.status(400).json({ error: 'city is required' });
    if (mode !== 'apollo' && !keyword) return res.status(400).json({ error: 'keyword is required for Google Maps mode' });

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'scraping', scrapeTotal: limit, scrapeComplete: 0, lastError: null },
      create: { campaignId, stage: 'scraping', scrapeTotal: limit, scrapeComplete: 0 },
    });

    await enqueue('lead-scrape', { campaignId, mode, keyword, city, limit, jobTitles, seniority }, { priority: 1 });
    res.json({ ok: true, stage: 'scraping' });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/upload-csv — import leads from CSV text
router.post('/:campaignId/upload-csv', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const { csvText, fieldMap = {} } = req.body;

    if (!csvText) return res.status(400).json({ error: 'csvText is required' });

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const Papa = (await import('papaparse')).default;
    const parsed = Papa.parse(csvText.trim(), { header: true, skipEmptyLines: true });
    const rows = parsed.data;
    if (!rows.length) return res.status(400).json({ error: 'CSV has no data rows' });

    const COMMON = {
      name: ['Name', 'name', 'Full Name', 'Contact Name', 'Business Name', 'contact_name'],
      company: ['Company', 'company', 'Organization', 'Business', 'Company Name', 'organization_name'],
      title: ['Title', 'title', 'Job Title', 'Position', 'Role', 'job_title'],
      phone: ['Phone', 'phone', 'Phone Number', 'Mobile', 'Tel', 'WhatsApp', 'phone_number'],
      email: ['Email', 'email', 'Email Address', 'E-mail', 'email_address'],
      website: ['Website', 'website', 'URL', 'Web', 'site'],
      address: ['Address', 'address', 'Location', 'City', 'full_address'],
    };

    function getField(row, fieldName) {
      if (fieldMap[fieldName] && row[fieldMap[fieldName]] !== undefined) return row[fieldMap[fieldName]] || '';
      for (const key of (COMMON[fieldName] || [])) {
        if (row[key] !== undefined) return row[key] || '';
      }
      return '';
    }

    const existing = await prisma.lead.findMany({ where: { campaignId }, select: { phone: true, email: true } });
    const existingPhones = new Set(existing.map(l => l.phone).filter(Boolean));
    const existingEmails = new Set(existing.map(l => l.email).filter(Boolean));

    const toInsert = [];
    for (const row of rows) {
      const name = getField(row, 'name');
      const company = getField(row, 'company');
      const phone = getField(row, 'phone').replace(/[\s\-()]/g, '');
      const email = getField(row, 'email').toLowerCase().trim();
      if (!name && !company) continue;
      if (phone && existingPhones.has(phone)) continue;
      if (email && existingEmails.has(email)) continue;
      const channels = [];
      if (phone) channels.push('whatsapp');
      if (email) channels.push('email');
      toInsert.push({
        campaignId, bizId: campaign.bizId,
        name: name || company || 'Unknown',
        company: company || '',
        title: getField(row, 'title'),
        phone, email,
        website: getField(row, 'website'),
        address: getField(row, 'address'),
        score: 0, status: 'new', lang: 'EN',
        channels: channels.length ? channels : ['email'],
        last: 'just now',
      });
    }

    if (!toInsert.length) return res.json({ count: 0, total: existing.length, msg: 'No new leads to import' });

    await prisma.lead.createMany({ data: toInsert });
    const newTotal = await prisma.lead.count({ where: { campaignId } });
    await prisma.campaign.update({ where: { id: campaignId }, data: { leads: newTotal } });

    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'scraped', scrapeTotal: newTotal, scrapeComplete: newTotal, scrapedAt: new Date(), lastError: null },
      create: { campaignId, stage: 'scraped', scrapeTotal: newTotal, scrapeComplete: newTotal, scrapedAt: new Date() },
    });

    await prisma.activity.create({
      data: { color: 'blue', msg: `Imported ${toInsert.length} leads from CSV for ${campaign.name}`, tag: 'Import' },
    }).catch(() => {});

    res.json({ count: toInsert.length, total: newTotal });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/validate — trigger lead validation
router.post('/:campaignId/validate', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'validating', lastError: null },
      create: { campaignId, stage: 'validating' },
    });
    await enqueue('lead-validation', { campaignId }, { priority: 2 });
    res.json({ ok: true, stage: 'validating' });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/validation-summary
router.get('/:campaignId/validation-summary', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });

    const tiers = await Promise.all(['A', 'B', 'C'].map(async tier => {
      const count = await prisma.leadScore.count({ where: { leadId: { in: (await prisma.lead.findMany({ where: { campaignId }, select: { id: true } })).map(l => l.id) }, tier } });
      const samples = await prisma.lead.findMany({
        where: { campaignId, tier },
        select: { id: true, name: true, company: true, title: true, phone: true, email: true, validationScore: true },
        take: 5,
      });
      return { tier, count, samples };
    }));

    res.json({ pipeline, tiers, totalLeads: (pipeline?.scrapeTotal || 0) });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/approve-tiers
router.post('/:campaignId/approve-tiers', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const { tiers } = req.body; // e.g. ['A', 'B']
    if (!tiers || !Array.isArray(tiers)) return res.status(400).json({ error: 'tiers array required' });

    await prisma.campaignPipeline.update({ where: { campaignId }, data: { approvedTiers: tiers } });

    // Mark leads not in approved tiers as low_quality (exclude from outreach)
    const approvedLeadIds = (await prisma.lead.findMany({ where: { campaignId, tier: { in: tiers } }, select: { id: true } })).map(l => l.id);
    await prisma.lead.updateMany({ where: { campaignId, tier: { notIn: tiers } }, data: { status: 'low_quality' } });

    // Trigger enrichment for approved leads
    const totalToEnrich = approvedLeadIds.length;
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'enriching', enrichTotal: totalToEnrich, enrichComplete: 0 } });
    await enqueueBatch('lead-enrichment', approvedLeadIds.map(leadId => ({ leadId, campaignId })));

    res.json({ ok: true, approved: approvedLeadIds.length, excluded: await prisma.lead.count({ where: { campaignId, status: 'low_quality' } }) });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/enrich-status
router.get('/:campaignId/enrich-status', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    res.json({ stage: pipeline?.stage, enrichTotal: pipeline?.enrichTotal || 0, enrichComplete: pipeline?.enrichComplete || 0 });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/generate-assets — trigger Opus asset generation
router.post('/:campaignId/generate-assets', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'ai_generating', lastError: null } });
    await enqueue('ai-asset-gen', { campaignId }, { priority: 3 });
    res.json({ ok: true, stage: 'ai_generating' });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/assets
router.get('/:campaignId/assets', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const assets = await prisma.campaignAsset.findMany({ where: { campaignId }, orderBy: { id: 'asc' } });
    res.json(assets);
  } catch (e) { next(e); }
});

// PATCH /pipeline/:campaignId/assets/:assetId
router.patch('/:campaignId/assets/:assetId', requireAuth, async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.assetId);
    const { editedBody, subject, approved, notes } = req.body;
    const update = {};
    if (editedBody !== undefined) update.editedBody = editedBody;
    if (subject !== undefined) update.subject = subject;
    if (approved !== undefined) update.approved = approved;
    if (notes !== undefined) update.notes = notes;
    const asset = await prisma.campaignAsset.update({ where: { id: assetId }, data: update });
    res.json(asset);
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/approve-all-assets — quick approve all
router.post('/:campaignId/approve-all-assets', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    await prisma.campaignAsset.updateMany({ where: { campaignId }, data: { approved: true } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/personalize — trigger Haiku batch personalization
router.post('/:campaignId/personalize', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const leads = await prisma.lead.findMany({
      where: { campaignId, personalized: false, status: { notIn: ['low_quality', 'unsubscribed', 'bounced'] } },
      select: { id: true },
    });

    if (leads.length === 0) {
      await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'personalized', personalizedAt: new Date(), personalizeTotal: 0, personalizeComplete: 0 } });
      return res.json({ ok: true, total: 0 });
    }

    const BATCH_SIZE = 50;
    const batches = [];
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
      batches.push(leads.slice(i, i + BATCH_SIZE).map(l => l.id));
    }

    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'personalizing', personalizeTotal: leads.length, personalizeComplete: 0 } });
    await enqueueBatch('lead-personalize', batches.map(leadIds => ({ campaignId, leadIds })));

    res.json({ ok: true, total: leads.length, batches: batches.length });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/personalize-status
router.get('/:campaignId/personalize-status', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const personalized = await prisma.lead.count({ where: { campaignId, personalized: true } });
    res.json({ stage: pipeline?.stage, personalizeTotal: pipeline?.personalizeTotal || 0, personalizeComplete: pipeline?.personalizeComplete || personalized });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/eligibility
router.get('/:campaignId/eligibility', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const ineligibleSamples = await prisma.leadEligibility.findMany({
      where: { campaignId, emailEligible: false, waEligible: false, voiceEligible: false },
      take: 10,
      include: { },
    });
    res.json({
      eligibleEmail: pipeline?.eligibleEmail || 0,
      eligibleWa: pipeline?.eligibleWa || 0,
      eligibleVoice: pipeline?.eligibleVoice || 0,
      ineligibleCount: pipeline?.ineligibleCount || 0,
      stage: pipeline?.stage,
    });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/check-eligibility — trigger eligibility check
router.post('/:campaignId/check-eligibility', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    await enqueue('channel-eligibility', { campaignId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/launch — final launch
router.post('/:campaignId/launch', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });

    if (!pipeline || pipeline.stage !== 'awaiting_launch') {
      return res.status(400).json({ error: `Cannot launch from stage: ${pipeline?.stage || 'no pipeline'}` });
    }

    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'active', startedAt: new Date() } });
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'active', launchedAt: new Date() } });

    res.json({ ok: true, stage: 'active' });
  } catch (e) { next(e); }
});

export default router;
