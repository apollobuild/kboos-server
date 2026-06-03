import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { enrichLead } from '../services/apollo.js';
import { syncLeads } from '../services/googleDrive.js';
import prisma from '../db.js';

const router = Router();
// POST /enrichment/start/:campaignId
router.post('/start/:campaignId', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'enriching' } });
    res.json({ ok: true, msg: 'Enrichment started' });

    // Run async without blocking response
    setImmediate(async () => {
      const leads = await prisma.lead.findMany({ where: { campaignId, enriched: false } });
      const city = campaign.config?.google_maps?.city || '';

      for (const lead of leads) {
        try {
          const result = await enrichLead({ companyName: lead.company, city });
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              enriched: true,
              enrichedAt: new Date(),
              enrichmentNote: result ? 'success' : 'no_data',
              ...(result?.email ? { email: result.email } : {}),
              ...(result?.title && !lead.title ? { title: result.title } : {}),
              // If lead is a raw business entry (name = company), use decision maker name
              ...(result?.decisionMakerName && lead.name === lead.company
                ? { name: result.decisionMakerName }
                : {}),
            },
          });
        } catch {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { enriched: true, enrichedAt: new Date(), enrichmentNote: 'error' },
          }).catch(() => {});
        }
      }

      await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'awaiting_launch' } });

      if (campaign.driveSheetId) {
        const allLeads = await prisma.lead.findMany({ where: { campaignId } });
        await syncLeads({ spreadsheetId: campaign.driveSheetId, leads: allLeads }).catch(() => {});
      }

      await prisma.activity.create({
        data: { color: 'blue', msg: `Enrichment complete for "${campaign.name}"`, tag: 'Enrichment' },
      }).catch(() => {});
    });
  } catch (e) { next(e); }
});

// GET /enrichment/status/:campaignId
router.get('/status/:campaignId', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const [total, success, noData, errors, campaign] = await Promise.all([
      prisma.lead.count({ where: { campaignId } }),
      prisma.lead.count({ where: { campaignId, enrichmentNote: 'success' } }),
      prisma.lead.count({ where: { campaignId, enrichmentNote: 'no_data' } }),
      prisma.lead.count({ where: { campaignId, enrichmentNote: 'error' } }),
      prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }),
    ]);
    const done = success + noData + errors;
    res.json({ total, enriched: success, noData, errors, done, complete: campaign?.status !== 'enriching', campaignStatus: campaign?.status });
  } catch (e) { next(e); }
});

// GET /enrichment/credit-estimate/:campaignId
router.get('/credit-estimate/:campaignId', requireAuth, async (req, res, next) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const total = await prisma.lead.count({ where: { campaignId, enriched: false } });
    res.json({ creditsNeeded: total, note: 'Apollo Professional: people search unlimited. Mobile lookups cost extra.' });
  } catch (e) { next(e); }
});

export default router;
