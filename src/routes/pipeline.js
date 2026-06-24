import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { enqueue, enqueueBatch } from '../services/queue.js';
import { getApiKey } from '../services/apiKeys.js';
import { generateCampaignAssets, testConnection as testClaude } from '../services/claude.js';
import { testConnection as testSendGrid } from '../services/sendgrid.js';
import { testConnection as testWati } from '../services/wati.js';
import { testConnection as testVapi } from '../services/vapi.js';
import { isValidMobile } from '../services/tenantConfig.js';
import { isWithinSendWindow } from '../engine/campaignRunner.js';
import prisma from '../db.js';

const router = Router();

// Verify campaign ownership — used by every handler to prevent cross-tenant access
async function getCampaign(campaignId, tid) {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: tid } });
  return c || null;
}

// Default outreach cadence when a campaign reaches launch without sequence
// steps (Quick Setup campaigns never get one) — the engine silently skips
// campaigns with an empty sequence, so launching without this sends nothing
function buildDefaultSequence(channels = []) {
  const seq = [];
  if (channels.includes('wa')) {
    seq.push({ day: 1, type: 'wa' }, { day: 4, type: 'wa', skipIfReplied: true });
  }
  if (channels.includes('email')) {
    seq.push({ day: 2, type: 'email' }, { day: 6, type: 'email', skipIfReplied: true });
  }
  if (channels.includes('voice') || channels.includes('call')) {
    seq.push({ day: 5, type: 'call', skipIfReplied: true });
  }
  return seq;
}

// GET /pipeline/:campaignId — full pipeline status
router.get('/:campaignId', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const assetCount = await prisma.campaignAsset.count({ where: { campaignId } });
    const approvedAssets = await prisma.campaignAsset.count({ where: { campaignId, approved: true } });
    const personalizedLeads = await prisma.lead.count({ where: { campaignId, personalized: true, tenantId: tid } });
    const totalLeads = await prisma.lead.count({ where: { campaignId, tenantId: tid } });

    res.json({
      campaign,
      pipeline: pipeline || { campaignId, stage: 'draft' },
      assetCount,
      approvedAssets,
      personalizedLeads,
      totalLeads,
    });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/scrape — trigger Google Maps / Apollo scrape via queue
router.post('/:campaignId/scrape', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;
    const { mode = 'gmaps', keyword, city, limit = 50, jobTitles = [], seniority = [] } = req.body;

    if (!city) return res.status(400).json({ error: 'city is required' });
    if (mode !== 'apollo' && !keyword) return res.status(400).json({ error: 'keyword is required for Google Maps mode' });

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'scraping', scrapeTotal: limit, scrapeComplete: 0, lastError: null },
      create: { campaignId, tenantId: tid, stage: 'scraping', scrapeTotal: limit, scrapeComplete: 0 },
    });

    await enqueue('lead-scrape', { campaignId, mode, keyword, city, limit, jobTitles, seniority }, { priority: 1 });
    res.json({ ok: true, stage: 'scraping' });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/upload-csv — import leads from CSV text
router.post('/:campaignId/upload-csv', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;
    const { csvText, fieldMap = {} } = req.body;

    if (!csvText) return res.status(400).json({ error: 'csvText is required' });
    if (csvText.length > 5_000_000) return res.status(400).json({ error: 'CSV too large (max 5 MB)' });

    const campaign = await getCampaign(campaignId, tid);
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

    const existing = await prisma.lead.findMany({ where: { campaignId, tenantId: tid }, select: { phone: true, email: true } });
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
        campaignId, bizId: campaign.bizId, tenantId: tid,
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
    const newTotal = await prisma.lead.count({ where: { campaignId, tenantId: tid } });
    await prisma.campaign.update({ where: { id: campaignId }, data: { leads: newTotal } });

    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'scraped', scrapeTotal: newTotal, scrapeComplete: newTotal, scrapedAt: new Date(), lastError: null },
      create: { campaignId, tenantId: tid, stage: 'scraped', scrapeTotal: newTotal, scrapeComplete: newTotal, scrapedAt: new Date() },
    });

    await prisma.activity.create({
      data: { color: 'blue', msg: `Imported ${toInsert.length} leads from CSV for ${campaign.name}`, tag: 'Import', tenantId: tid },
    }).catch(() => {});

    res.json({ count: toInsert.length, total: newTotal });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/qualify — run scoring inline (pure JS, no queue needed)
router.post('/:campaignId/qualify', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'qualifying', lastError: null },
      create: { campaignId, tenantId: tid, stage: 'qualifying' },
    });

    const { scoreLeadQuality } = await import('../services/leadScoring.js');
    const leads = await prisma.lead.findMany({
      where: { campaignId, tenantId: tid },
      select: { id: true, phone: true, email: true, website: true, category: true, company: true, title: true, address: true, rating: true, reviewCount: true },
    });

    const cfg = campaign.config || {};
    let tierA = 0, tierB = 0, tierC = 0;

    const updates = leads.map(lead => {
      const result = scoreLeadQuality(lead, cfg);
      if (result.tier === 'A') tierA++;
      else if (result.tier === 'B') tierB++;
      else tierC++;
      return prisma.lead.update({
        where: { id: lead.id },
        data: { rawQualityScore: result.qualityScore, tier: result.tier, validationScore: result.qualityScore, status: 'qualified' },
      });
    });

    await Promise.all(updates);

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'ready_for_enrichment', tierA, tierB, tierC, qualifyTotal: leads.length, qualifyComplete: leads.length, qualifiedAt: new Date() },
    });

    res.json({ ok: true, stage: 'ready_for_enrichment', tierA, tierB, tierC, total: leads.length });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/qualify-summary — tier breakdown
router.get('/:campaignId/qualify-summary', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const totalLeads = await prisma.lead.count({ where: { campaignId, tenantId: tid } });

    const tiers = await Promise.all(['A', 'B', 'C'].map(async tier => {
      const count = await prisma.lead.count({ where: { campaignId, tier, tenantId: tid } });
      const samples = await prisma.lead.findMany({
        where: { campaignId, tier, tenantId: tid },
        select: { id: true, name: true, company: true, title: true, phone: true, email: true, validationScore: true, rawQualityScore: true },
        take: 3,
      });
      return { tier, count, samples };
    }));

    res.json({ pipeline, tiers, totalLeads });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/select-enrichment-tiers — approve which tiers to enrich
router.post('/:campaignId/select-enrichment-tiers', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;
    const { tiers } = req.body;
    if (!tiers || !Array.isArray(tiers)) return res.status(400).json({ error: 'tiers array required' });

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { approvedTiers: tiers, stage: 'ready_for_enrichment' },
    });

    res.json({ ok: true, approvedTiers: tiers, stage: 'ready_for_enrichment' });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/enrich — run enrichment inline (gracefully skips if no Apollo key)
router.post('/:campaignId/enrich', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const approvedTiers = pipeline?.approvedTiers || ['A', 'B'];

    const leads = await prisma.lead.findMany({
      where: { campaignId, tier: { in: approvedTiers }, tenantId: tid },
      select: { id: true, name: true, company: true, address: true, email: true, phone: true, title: true },
    });

    if (!leads.length) return res.status(400).json({ error: 'No leads in approved tiers to enrich' });

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'enriching', enrichTotal: leads.length, enrichComplete: 0 },
    });

    const { getApiKey } = await import('../services/apiKeys.js');
    const apolloKey = await getApiKey('apollo').catch(() => null);

    if (!apolloKey) {
      await prisma.lead.updateMany({ where: { id: { in: leads.map(l => l.id) }, tenantId: tid }, data: { enriched: true, enrichedAt: new Date(), enrichmentNote: 'Skipped — no Apollo key' } });
      await prisma.campaignPipeline.update({
        where: { campaignId },
        data: { stage: 'enrichment_complete', enrichComplete: leads.length, enrichedAt: new Date() },
      });
      return res.json({ ok: true, stage: 'enrichment_complete', total: leads.length, skipped: leads.length, note: 'No Apollo key — enrichment skipped' });
    }

    const { enrichLead } = await import('../services/apollo.js');
    let enriched = 0, skipped = 0;

    await Promise.all(leads.map(async (lead) => {
      try {
        const result = await enrichLead({ companyName: lead.company, city: lead.address?.split(',')[1]?.trim() || '' });
        if (result) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              name: result.decisionMakerName || lead.name,
              title: result.title || lead.title,
              email: result.email || lead.email,
              phone: result.phone || lead.phone,
              enriched: true, enrichedAt: new Date(),
              enrichmentNote: 'Apollo: found',
            },
          });
          enriched++;
        } else {
          await prisma.lead.update({ where: { id: lead.id }, data: { enriched: true, enrichedAt: new Date(), enrichmentNote: 'No match' } });
          skipped++;
        }
      } catch {
        await prisma.lead.update({ where: { id: lead.id }, data: { enriched: true, enrichedAt: new Date(), enrichmentNote: 'Error — skipped' } });
        skipped++;
      }
    }));

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'enrichment_complete', enrichComplete: leads.length, enrichedAt: new Date() },
    });

    res.json({ ok: true, stage: 'enrichment_complete', total: leads.length, enriched, skipped });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/ai-score — enqueue AI scoring batch job
router.post('/:campaignId/ai-score', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const approvedTiers = pipeline?.approvedTiers || ['A', 'B'];

    const leads = await prisma.lead.findMany({
      where: { campaignId, tier: { in: approvedTiers }, tenantId: tid },
      select: { id: true },
    });

    const BATCH_SIZE = 25; // 50-lead batches overflow the model's output token cap and truncate the JSON
    const batches = [];
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
      batches.push(leads.slice(i, i + BATCH_SIZE).map(l => l.id));
    }

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'ai_scoring', aiScoreTotal: leads.length, aiScoreComplete: 0 },
    });

    await enqueueBatch('lead-ai-score', batches.map(leadIds => ({ campaignId, leadIds })));
    res.json({ ok: true, stage: 'ai_scoring', total: leads.length, batches: batches.length });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/retry-ai-score — retry failed AI scoring jobs
router.post('/:campaignId/retry-ai-score', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const approvedTiers = pipeline?.approvedTiers || ['A', 'B'];

    const leads = await prisma.lead.findMany({
      where: { campaignId, tier: { in: approvedTiers }, tenantId: tid },
      select: { id: true },
    });

    const BATCH_SIZE = 25; // 50-lead batches overflow the model's output token cap and truncate the JSON
    const batches = [];
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
      batches.push(leads.slice(i, i + BATCH_SIZE).map(l => l.id));
    }

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'ai_scoring', aiScoreTotal: leads.length, aiScoreComplete: 0, lastError: null },
    });

    await enqueueBatch('lead-ai-score', batches.map(leadIds => ({ campaignId, leadIds })));
    res.json({ ok: true, stage: 'ai_scoring', total: leads.length, batches: batches.length });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/generate-assets — trigger Opus asset generation
router.post('/:campaignId/generate-assets', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'ai_generating', lastError: null } });
    await enqueue('ai-asset-gen', { campaignId }, { priority: 3 });
    res.json({ ok: true, stage: 'ai_generating' });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/assets
router.get('/:campaignId/assets', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const assets = await prisma.campaignAsset.findMany({ where: { campaignId }, orderBy: { id: 'asc' } });
    res.json(assets);
  } catch (e) { next(e); }
});

// PATCH /pipeline/:campaignId/assets/:assetId
router.patch('/:campaignId/assets/:assetId', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const assetId = parseInt(req.params.assetId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { editedBody, subject, approved, notes } = req.body;
    const update = {};
    if (editedBody !== undefined) update.editedBody = editedBody;
    if (subject !== undefined) update.subject = subject;
    if (approved !== undefined) update.approved = approved;
    if (notes !== undefined) update.notes = notes;
    const asset = await prisma.campaignAsset.update({ where: { id: assetId, campaignId }, data: update });
    res.json(asset);
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/assets/add — add a standalone asset from AI Studio
router.post('/:campaignId/assets/add', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { assetType, channel, label, subject, body, approved } = req.body;
    const asset = await prisma.campaignAsset.create({
      data: { campaignId, tenantId: tid, assetType: assetType || 'custom', channel: channel || 'email', label: label || 'Asset', subject: subject || '', body: body || '', approved: !!approved },
    });
    res.json(asset);
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/approve-all-assets — quick approve all
router.post('/:campaignId/approve-all-assets', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaignAsset.updateMany({ where: { campaignId }, data: { approved: true } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/personalize — trigger Haiku batch personalization
router.post('/:campaignId/personalize', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const leads = await prisma.lead.findMany({
      where: { campaignId, personalized: false, tenantId: tid, status: { notIn: ['low_quality', 'unsubscribed', 'bounced'] } },
      select: { id: true },
    });

    if (leads.length === 0) {
      await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'personalizing', personalizedAt: new Date(), personalizeTotal: 0, personalizeComplete: 0 } });
      return res.json({ ok: true, total: 0 });
    }

    const BATCH_SIZE = 25; // 50-lead batches overflow the model's output token cap and truncate the JSON
    const batches = [];
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
      batches.push(leads.slice(i, i + BATCH_SIZE).map(l => l.id));
    }

    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'personalizing', personalizeTotal: leads.length, personalizeComplete: 0 } });
    await enqueueBatch('lead-personalize', batches.map(leadIds => ({ campaignId, leadIds })));

    res.json({ ok: true, total: leads.length, batches: batches.length });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/configure-channels — save channel config and run eligibility
router.post('/:campaignId/configure-channels', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;
    const { channels = [], strategy = 'balanced', waNumberId } = req.body;

    if (!channels.length) return res.status(400).json({ error: 'channels array is required' });

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const updatedConfig = { ...(campaign.config || {}), waNumberId: waNumberId || null };

    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { channelConfig: { channels, strategy } },
      create: { campaignId, tenantId: tid, channelConfig: { channels, strategy } },
    });
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { channels, channelStrategy: strategy, config: updatedConfig },
    });

    const leads = await prisma.lead.findMany({
      where: { campaignId, tenantId: tid },
      select: { id: true, email: true, phone: true },
    });

    let emailEligible = 0, emailIneligible = 0;
    let waEligible = 0, waIneligible = 0;
    let voiceEligible = 0, voiceIneligible = 0;

    const emailEligibleIds = [], emailIneligibleIds = [];
    const waEligibleIds = [], waIneligibleIds = [];
    const voiceEligibleIds = [], voiceIneligibleIds = [];

    for (const lead of leads) {
      const hasEmail = channels.includes('email') && !!(lead.email && lead.email.includes('@') && lead.email.includes('.'));
      // Mobile-only check: 601x is WhatsApp-capable, 603/604/… landlines are not
      const hasWa = channels.includes('wa') && isValidMobile(lead.phone);
      const hasVoice = channels.includes('voice') && !!lead.phone;

      if (channels.includes('email')) { hasEmail ? (emailEligible++, emailEligibleIds.push(lead.id)) : (emailIneligible++, emailIneligibleIds.push(lead.id)); }
      if (channels.includes('wa')) { hasWa ? (waEligible++, waEligibleIds.push(lead.id)) : (waIneligible++, waIneligibleIds.push(lead.id)); }
      if (channels.includes('voice')) { hasVoice ? (voiceEligible++, voiceEligibleIds.push(lead.id)) : (voiceIneligible++, voiceIneligibleIds.push(lead.id)); }
    }

    // Batch updates instead of per-lead queries (N queries → max 6 queries)
    const batchUpdates = [];
    if (channels.includes('email')) {
      if (emailEligibleIds.length) batchUpdates.push(prisma.lead.updateMany({ where: { id: { in: emailEligibleIds } }, data: { emailEligible: true, eligibilityChecked: true } }));
      if (emailIneligibleIds.length) batchUpdates.push(prisma.lead.updateMany({ where: { id: { in: emailIneligibleIds } }, data: { emailEligible: false, eligibilityChecked: true } }));
    }
    if (channels.includes('wa')) {
      if (waEligibleIds.length) batchUpdates.push(prisma.lead.updateMany({ where: { id: { in: waEligibleIds } }, data: { waEligible: true, eligibilityChecked: true } }));
      if (waIneligibleIds.length) batchUpdates.push(prisma.lead.updateMany({ where: { id: { in: waIneligibleIds } }, data: { waEligible: false, eligibilityChecked: true } }));
    }
    if (channels.includes('voice')) {
      if (voiceEligibleIds.length) batchUpdates.push(prisma.lead.updateMany({ where: { id: { in: voiceEligibleIds } }, data: { voiceEligible: true, eligibilityChecked: true } }));
      if (voiceIneligibleIds.length) batchUpdates.push(prisma.lead.updateMany({ where: { id: { in: voiceIneligibleIds } }, data: { voiceEligible: false, eligibilityChecked: true } }));
    }
    await Promise.all(batchUpdates);

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: {
        stage: 'deliverability_check',
        eligibleEmail: emailEligible,
        eligibleWa: waEligible,
        eligibleVoice: voiceEligible,
        ineligibleCount: leads.length - Math.max(emailEligible, waEligible, voiceEligible),
      },
    });

    res.json({
      ok: true,
      stage: 'deliverability_check',
      eligibility: {
        email: { eligible: emailEligible, ineligible: emailIneligible },
        wa: { eligible: waEligible, ineligible: waIneligible },
        voice: { eligible: voiceEligible, ineligible: voiceIneligible },
        totalLeads: leads.length,
      },
    });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/channel-eligibility
router.get('/:campaignId/channel-eligibility', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const [emailEligible, emailIneligible, waEligible, waIneligible, voiceEligible, voiceIneligible] = await Promise.all([
      prisma.lead.count({ where: { campaignId, emailEligible: true, tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, emailEligible: false, eligibilityChecked: true, tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, waEligible: true, tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, waEligible: false, eligibilityChecked: true, tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, voiceEligible: true, tenantId: tid } }),
      prisma.lead.count({ where: { campaignId, voiceEligible: false, eligibilityChecked: true, tenantId: tid } }),
    ]);

    const totalEligible = await prisma.lead.count({
      where: { campaignId, tenantId: tid, eligibilityChecked: true, OR: [{ emailEligible: true }, { waEligible: true }, { voiceEligible: true }] },
    });
    const totalIneligible = await prisma.lead.count({
      where: { campaignId, tenantId: tid, eligibilityChecked: true, emailEligible: false, waEligible: false, voiceEligible: false },
    });

    res.json({
      eligibleEmail: emailEligible,
      ineligibleEmail: emailIneligible,
      eligibleWa: waEligible,
      ineligibleWa: waIneligible,
      eligibleVoice: voiceEligible,
      ineligibleVoice: voiceIneligible,
      totalEligible,
      totalIneligible,
    });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/run-deliverability — run all checks
router.post('/:campaignId/run-deliverability', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const channels = (pipeline?.channelConfig?.channels?.length ? pipeline.channelConfig.channels : campaign.channels) || [];
    const usesVoice = channels.includes('voice') || channels.includes('call');

    const checks = [];
    let score = 100;

    // Live connection tests, not just "is a key saved" — only for selected channels
    {
      const k = await getApiKey('claude').catch(() => null);
      const ok = k ? await testClaude(k).catch(() => false) : false;
      checks.push({ label: 'Claude AI', pass: ok, detail: ok ? 'Connected' : (k ? 'Key saved but connection test failed' : 'API key missing') });
      if (!ok) score -= 30;
    }

    if (channels.includes('email')) {
      const k = await getApiKey('sendgrid').catch(() => null);
      const ok = k ? await testSendGrid(k).catch(() => false) : false;
      checks.push({ label: 'SendGrid Email', pass: ok, detail: ok ? 'Connected' : (k ? 'Key saved but connection test failed' : 'API key missing — email sends will fail') });
      if (!ok) score -= 25;
    } else {
      checks.push({ label: 'SendGrid Email', pass: null, detail: 'Email channel not selected — skipped' });
    }

    if (channels.includes('wa')) {
      const k = await getApiKey('wati').catch(() => null);
      const url = await getApiKey('wati_url').catch(() => null);
      const ok = k ? await testWati(k, url).catch(() => false) : false;
      checks.push({ label: 'WATI WhatsApp', pass: ok, detail: ok ? 'Connected' : (k ? 'Token saved but connection test failed' : 'Token missing — WhatsApp sends will fail') });
      if (!ok) score -= 25;
    } else {
      checks.push({ label: 'WATI WhatsApp', pass: null, detail: 'WhatsApp channel not selected — skipped' });
    }

    if (usesVoice) {
      const k = await getApiKey('vapi').catch(() => null);
      const ok = k ? await testVapi(k).catch(() => false) : false;
      checks.push({ label: 'Vapi Voice', pass: ok, detail: ok ? 'Connected' : (k ? 'Key saved but connection test failed' : 'API key missing — voice calls will fail') });
      if (!ok) score -= 15;
    }

    // Per-channel eligible leads — a channel with zero reachable leads sends nothing
    const eligibilityFields = { email: 'emailEligible', wa: 'waEligible', voice: 'voiceEligible' };
    for (const [ch, field] of Object.entries(eligibilityFields)) {
      if (!(channels.includes(ch) || (ch === 'voice' && usesVoice))) continue;
      const count = await prisma.lead.count({ where: { campaignId, tenantId: tid, [field]: true } });
      checks.push({ label: `${ch === 'wa' ? 'WhatsApp' : ch === 'email' ? 'Email' : 'Voice'}-eligible leads`, pass: count > 0, detail: `${count} leads can receive this channel` });
      if (count === 0) score -= 20;
    }

    // Approved assets per channel — the senders refuse unapproved content
    for (const ch of ['email', 'wa', 'voice']) {
      if (!(channels.includes(ch) || (ch === 'voice' && usesVoice))) continue;
      const count = await prisma.campaignAsset.count({ where: { campaignId, channel: ch, approved: true } });
      checks.push({ label: `Approved ${ch === 'wa' ? 'WhatsApp' : ch} assets`, pass: count > 0, detail: count > 0 ? `${count} approved` : 'None approved — approve in the AI Assets step' });
      if (count === 0) score -= 20;
    }

    const finalScore = Math.max(0, score);
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: {
        deliverabilityScore: finalScore,
        deliverabilityDetail: { checks },
        stage: finalScore >= 50 ? 'ready_to_launch' : 'deliverability_check',
      },
    });

    res.json({ score: finalScore, checks, stage: finalScore >= 50 ? 'ready_to_launch' : 'deliverability_check' });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/deliverability — return score + detail
router.get('/:campaignId/deliverability', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    res.json({
      deliverabilityScore: pipeline?.deliverabilityScore || 0,
      deliverabilityDetail: pipeline?.deliverabilityDetail || null,
      stage: pipeline?.stage || 'draft',
    });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/launch — final launch (from ready_to_launch)
router.post('/:campaignId/launch', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    if (!pipeline || pipeline.stage !== 'ready_to_launch') {
      return res.status(400).json({ error: `Cannot launch from stage: ${pipeline?.stage || 'no pipeline'}` });
    }

    // The engine skips campaigns with no sequence — build the default cadence
    let sequence = Array.isArray(campaign.sequence) ? campaign.sequence : [];
    if (!sequence.length) {
      const channels = (pipeline.channelConfig?.channels?.length ? pipeline.channelConfig.channels : campaign.channels) || [];
      sequence = buildDefaultSequence(channels);
      if (!sequence.length) {
        return res.status(400).json({ error: 'Campaign has no sequence steps and no channels configured — complete the Channel Strategy step first' });
      }
      await prisma.campaign.update({ where: { id: campaignId }, data: { sequence } });
    }

    // Every channel in the sequence needs at least one approved asset,
    // since the senders refuse to send unapproved content
    const seqChannels = [...new Set(sequence.map(s => (s.type === 'call' ? 'voice' : s.type)))];
    for (const ch of seqChannels) {
      const approvedCount = await prisma.campaignAsset.count({ where: { campaignId, channel: ch, approved: true } });
      if (!approvedCount) {
        return res.status(400).json({ error: `No approved ${ch} assets — approve at least one in the AI Assets step before launching` });
      }
    }

    // Cold WhatsApp outreach needs an approved WATI template — without it every
    // cold send fails and the circuit breaker pauses the campaign. Block here so
    // the template is set up front instead of leaving it silently stuck.
    if (seqChannels.includes('wa') && !campaign.config?.waTemplateName?.trim()) {
      return res.status(400).json({ error: 'No WhatsApp template set — add your approved WATI template name in Sending Settings (Launch step) before launching' });
    }

    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'active', startedAt: new Date() } });
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'active', launchedAt: new Date() } });

    // Kick an immediate send tick so launching during business hours starts
    // sending now instead of waiting for the top of the next hour
    import('../engine/campaignRunner.js')
      .then(({ runTick }) => runTick())
      .catch(err => console.error('[Launch] Immediate tick failed:', err.message));

    res.json({ ok: true, stage: 'active', sequenceSteps: sequence.length });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/retry-sends — clear failed/skipped so the engine
// re-attempts them (use after fixing the cause, e.g. approving a template)
router.post('/:campaignId/retry-sends', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Reset the retry counter so capped leads become eligible again; the next
    // engine tick reuses these rows and re-sends
    const { count } = await prisma.campaignAction.updateMany({
      where: { campaignId, status: { in: ['failed', 'skipped'] } },
      data: { retryCount: 0 },
    });

    // Resume if the circuit breaker auto-paused it, and clear the error banner
    if (campaign.status === 'paused') {
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'active' } });
    }
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { lastError: null } }).catch(() => {});

    // Kick an immediate tick so the retry happens now (within the send window)
    import('../engine/campaignRunner.js')
      .then(({ runTick }) => runTick())
      .catch(err => console.error('[RetrySends] Immediate tick failed:', err.message));

    res.json({ ok: true, requeued: count });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/send-issues — delivery results + grouped failure reasons
router.get('/:campaignId/send-issues', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const tid = req.user.tenantId;

    const campaign = await getCampaign(campaignId, tid);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const [sent, failed, skipped, pendingTotal, totalLeads] = await Promise.all([
      prisma.campaignAction.groupBy({ by: ['type'], where: { campaignId, status: 'sent' }, _count: { id: true } }),
      prisma.campaignAction.findMany({ where: { campaignId, status: 'failed' }, select: { type: true, errorMsg: true }, take: 500 }),
      prisma.campaignAction.findMany({ where: { campaignId, status: 'skipped' }, select: { type: true, errorMsg: true }, take: 500 }),
      prisma.campaignAction.count({ where: { campaignId, status: 'pending' } }),
      prisma.lead.count({ where: { campaignId } }),
    ]);

    // Group failures/skips by reason so the operator sees "X leads failed because Y"
    const group = (rows) => {
      const m = {};
      for (const r of rows) {
        const key = r.errorMsg || 'Unknown reason';
        m[key] = (m[key] || 0) + 1;
      }
      return Object.entries(m).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    };

    const sentByType = {};
    for (const s of sent) sentByType[s.type] = s._count.id;
    const sentTotal = sent.reduce((n, s) => n + s._count.id, 0);

    // Engine-state signals so the panel can distinguish "healthy" from
    // "silently doing nothing" — a campaign can sit at 0/0/0 because it's
    // outside the send window, paused, has no template, or no leads, none of
    // which the sent/failed/skipped counters reveal on their own.
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } }).catch(() => null);
    const channels = (pipeline?.channelConfig?.channels?.length ? pipeline.channelConfig.channels : campaign.channels) || [];
    const attemptedTotal = sentTotal + failed.length + skipped.length;

    res.json({
      sent: sentByType,
      sentTotal,
      failedTotal: failed.length,
      skippedTotal: skipped.length,
      failures: group(failed),
      skips: group(skipped),
      // Live engine state
      pendingTotal,
      attemptedTotal,
      totalLeads,
      status: campaign.status,                       // active | paused | ...
      withinSendWindow: isWithinSendWindow(new Date()),
      waTemplateMissing: channels.includes('wa') && !campaign.config?.waTemplateName?.trim(),
      lastError: pipeline?.lastError || null,
    });
  } catch (e) { next(e); }
});

export default router;
