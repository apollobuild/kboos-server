import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { enqueue, enqueueBatch } from '../services/queue.js';
import { getApiKey } from '../services/apiKeys.js';
import { generateCampaignAssets } from '../services/claude.js';

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
      update: { stage: 'qualifying', scrapeTotal: newTotal, scrapeComplete: newTotal, scrapedAt: new Date(), lastError: null },
      create: { campaignId, stage: 'qualifying', scrapeTotal: newTotal, scrapeComplete: newTotal, scrapedAt: new Date() },
    });

    await prisma.activity.create({
      data: { color: 'blue', msg: `Imported ${toInsert.length} leads from CSV for ${campaign.name}`, tag: 'Import' },
    }).catch(() => {});

    res.json({ count: toInsert.length, total: newTotal });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/qualify — enqueue qualify job
router.post('/:campaignId/qualify', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { stage: 'qualifying', lastError: null },
      create: { campaignId, stage: 'qualifying' },
    });

    await enqueue('lead-qualify', { campaignId }, { priority: 2 });
    res.json({ ok: true, stage: 'qualifying' });
  } catch (e) { next(e); }
});

// GET /pipeline/:campaignId/qualify-summary — tier breakdown
router.get('/:campaignId/qualify-summary', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const totalLeads = await prisma.lead.count({ where: { campaignId } });

    const tiers = await Promise.all(['A', 'B', 'C'].map(async tier => {
      const count = await prisma.lead.count({ where: { campaignId, tier } });
      const samples = await prisma.lead.findMany({
        where: { campaignId, tier },
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
    const { tiers } = req.body;
    if (!tiers || !Array.isArray(tiers)) return res.status(400).json({ error: 'tiers array required' });

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { approvedTiers: tiers, stage: 'ready_for_enrichment' },
    });

    res.json({ ok: true, approvedTiers: tiers, stage: 'ready_for_enrichment' });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/enrich — manual trigger: enqueue enrichment for approved tiers
router.post('/:campaignId/enrich', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const approvedTiers = pipeline?.approvedTiers || ['A', 'B'];

    const leads = await prisma.lead.findMany({
      where: { campaignId, tier: { in: approvedTiers } },
      select: { id: true },
    });

    if (!leads.length) return res.status(400).json({ error: 'No leads in approved tiers to enrich' });

    const totalToEnrich = leads.length;
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'enriching', enrichTotal: totalToEnrich, enrichComplete: 0 },
    });

    await enqueueBatch('lead-enrichment', leads.map(l => ({ leadId: l.id, campaignId })));
    res.json({ ok: true, stage: 'enriching', total: totalToEnrich });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/ai-score — enqueue AI scoring batch job
router.post('/:campaignId/ai-score', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });
    const approvedTiers = pipeline?.approvedTiers || ['A', 'B'];

    const leads = await prisma.lead.findMany({
      where: { campaignId, tier: { in: approvedTiers } },
      select: { id: true },
    });

    const BATCH_SIZE = 50;
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

// POST /pipeline/:campaignId/generate-assets — trigger Opus asset generation
router.post('/:campaignId/generate-assets', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
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
      await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'personalizing', personalizedAt: new Date(), personalizeTotal: 0, personalizeComplete: 0 } });
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

// POST /pipeline/:campaignId/configure-channels — save channel config and run eligibility
router.post('/:campaignId/configure-channels', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const { channels = [], strategy = 'balanced' } = req.body;

    if (!channels.length) return res.status(400).json({ error: 'channels array is required' });

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Save channel config to pipeline and campaign
    await prisma.campaignPipeline.upsert({
      where: { campaignId },
      update: { channelConfig: { channels, strategy } },
      create: { campaignId, channelConfig: { channels, strategy } },
    });
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { channels, channelStrategy: strategy },
    });

    // Run eligibility filter inline for all leads
    const leads = await prisma.lead.findMany({
      where: { campaignId },
      select: { id: true, email: true, phone: true },
    });

    let emailEligible = 0, emailIneligible = 0;
    let waEligible = 0, waIneligible = 0;
    let voiceEligible = 0, voiceIneligible = 0;

    for (const lead of leads) {
      const hasEmail = channels.includes('email') && lead.email && lead.email.includes('@') && lead.email.includes('.');
      const digits = (lead.phone || '').replace(/\D/g, '');
      const hasWa = channels.includes('wa') && lead.phone && digits.startsWith('60') && digits.length >= 10 && digits.length <= 12;
      const hasVoice = channels.includes('voice') && !!lead.phone;

      if (channels.includes('email')) { hasEmail ? emailEligible++ : emailIneligible++; }
      if (channels.includes('wa')) { hasWa ? waEligible++ : waIneligible++; }
      if (channels.includes('voice')) { hasVoice ? voiceEligible++ : voiceIneligible++; }

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          emailEligible: hasEmail,
          waEligible: hasWa,
          voiceEligible: hasVoice,
          eligibilityChecked: true,
        },
      });
    }

    // Update pipeline with eligibility counts and stage
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: {
        stage: 'channels_configured',
        eligibleEmail: emailEligible,
        eligibleWa: waEligible,
        eligibleVoice: voiceEligible,
        ineligibleCount: leads.length - Math.max(emailEligible, waEligible, voiceEligible),
      },
    });

    res.json({
      ok: true,
      stage: 'channels_configured',
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

    const [emailEligible, emailIneligible, waEligible, waIneligible, voiceEligible, voiceIneligible] = await Promise.all([
      prisma.lead.count({ where: { campaignId, emailEligible: true } }),
      prisma.lead.count({ where: { campaignId, emailEligible: false, eligibilityChecked: true } }),
      prisma.lead.count({ where: { campaignId, waEligible: true } }),
      prisma.lead.count({ where: { campaignId, waEligible: false, eligibilityChecked: true } }),
      prisma.lead.count({ where: { campaignId, voiceEligible: true } }),
      prisma.lead.count({ where: { campaignId, voiceEligible: false, eligibilityChecked: true } }),
    ]);

    const totalEligible = await prisma.lead.count({
      where: { campaignId, eligibilityChecked: true, OR: [{ emailEligible: true }, { waEligible: true }, { voiceEligible: true }] },
    });
    const totalIneligible = await prisma.lead.count({
      where: { campaignId, eligibilityChecked: true, emailEligible: false, waEligible: false, voiceEligible: false },
    });

    res.json({
      email: { eligible: emailEligible, ineligible: emailIneligible, reasons: [] },
      wa: { eligible: waEligible, ineligible: waIneligible },
      voice: { eligible: voiceEligible, ineligible: voiceIneligible },
      totalEligible,
      totalIneligible,
    });
  } catch (e) { next(e); }
});

// POST /pipeline/:campaignId/run-deliverability — run all checks
router.post('/:campaignId/run-deliverability', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const checks = [];
    let score = 100;

    // Check Claude key
    try {
      const k = await getApiKey('claude');
      checks.push({ name: 'Claude AI', status: k ? 'ok' : 'fail', detail: k ? 'Connected' : 'API key missing' });
      if (!k) score -= 30;
    } catch { score -= 30; checks.push({ name: 'Claude AI', status: 'fail', detail: 'Error checking key' }); }

    // Check SendGrid
    try {
      const k = await getApiKey('sendgrid');
      checks.push({ name: 'SendGrid Email', status: k ? 'ok' : 'warn', detail: k ? 'Connected' : 'API key missing — email channel disabled' });
      if (!k) score -= 20;
    } catch { score -= 20; checks.push({ name: 'SendGrid Email', status: 'warn', detail: 'Error checking key' }); }

    // Check WATI
    try {
      const k = await getApiKey('wati');
      checks.push({ name: 'WATI WhatsApp', status: k ? 'ok' : 'warn', detail: k ? 'Connected' : 'API key missing — WhatsApp channel disabled' });
      if (!k) score -= 20;
    } catch { score -= 20; checks.push({ name: 'WATI WhatsApp', status: 'warn', detail: 'Error checking key' }); }

    // Check Vapi
    try {
      const k = await getApiKey('vapi');
      checks.push({ name: 'Vapi Voice', status: k ? 'ok' : 'warn', detail: k ? 'Connected' : 'API key missing — voice channel disabled' });
      if (!k) score -= 10;
    } catch { score -= 10; checks.push({ name: 'Vapi Voice', status: 'warn', detail: 'Error checking key' }); }

    // Check eligible leads exist
    const eligibleCount = await prisma.lead.count({
      where: {
        campaignId,
        eligibilityChecked: true,
        OR: [{ emailEligible: true }, { waEligible: true }, { voiceEligible: true }],
      },
    });
    checks.push({
      name: 'Eligible Leads',
      status: eligibleCount > 0 ? 'ok' : 'fail',
      detail: `${eligibleCount} leads ready for outreach`,
    });
    if (eligibleCount === 0) score -= 30;

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
    const pipeline = await prisma.campaignPipeline.findUnique({ where: { campaignId } });

    if (!pipeline || pipeline.stage !== 'ready_to_launch') {
      return res.status(400).json({ error: `Cannot launch from stage: ${pipeline?.stage || 'no pipeline'}` });
    }

    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'active', startedAt: new Date() } });
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'active', launchedAt: new Date() } });

    res.json({ ok: true, stage: 'active' });
  } catch (e) { next(e); }
});

export default router;
