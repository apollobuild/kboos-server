import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { searchGoogleMaps, mapPlaceToLead } from '../services/outscraper.js';

const router = Router();
const prisma = new PrismaClient();

// POST /scraper/google-maps
// Body: { campaignId, keyword, city, radius, limit }
// Blocks until scrape completes and leads are saved. Returns { count, leads }.
router.post('/google-maps', requireAuth, async (req, res, next) => {
  try {
    const { campaignId, keyword, city, radius = 10, limit = 50 } = req.body;
    if (!campaignId || !keyword || !city) {
      return res.status(400).json({ error: 'campaignId, keyword and city are required' });
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: parseInt(campaignId) } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const query = `${keyword} in ${city}, Malaysia`;
    const places = await searchGoogleMaps({ query, limit: Math.min(limit, 100) });

    if (!places.length) return res.json({ count: 0, leads: [] });

    // Deduplicate by phone number (skip if phone already exists in this campaign)
    const existing = await prisma.lead.findMany({
      where: { campaignId: parseInt(campaignId) },
      select: { phone: true },
    });
    const existingPhones = new Set(existing.map(l => l.phone).filter(Boolean));

    const toInsert = places
      .map(place => mapPlaceToLead({ place, campaignId: parseInt(campaignId), bizId: campaign.bizId }))
      .filter(lead => !lead.phone || !existingPhones.has(lead.phone));

    if (!toInsert.length) return res.json({ count: 0, leads: [], msg: 'All leads already exist' });

    await prisma.lead.createMany({ data: toInsert });

    // Update campaign lead count
    const newTotal = await prisma.lead.count({ where: { campaignId: parseInt(campaignId) } });
    await prisma.campaign.update({
      where: { id: parseInt(campaignId) },
      data: { leads: newTotal },
    });

    await prisma.activity.create({
      data: {
        color: 'green',
        msg: `Scraped ${toInsert.length} leads from Google Maps for ${campaign.name}`,
        tag: 'Scraper',
      },
    });

    res.json({ count: toInsert.length, total: newTotal });
  } catch (e) { next(e); }
});

// POST /scraper/apollo
// Body: { campaignId, jobTitles, seniority, city, limit }
router.post('/apollo', requireAuth, async (req, res, next) => {
  try {
    const { campaignId, jobTitles = [], seniority = [], city, limit = 50 } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });

    const { getApiKey } = await import('../services/apiKeys.js');
    const apolloKey = await getApiKey('apollo');
    if (!apolloKey) return res.status(400).json({ error: 'Apollo API key not configured' });

    const campaign = await prisma.campaign.findUnique({ where: { id: parseInt(campaignId) } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const body = {
      q_organization_locations: city ? [`${city}, Malaysia`] : ['Malaysia'],
      person_seniorities: seniority.length ? seniority : ['owner', 'founder', 'c_suite', 'director', 'manager'],
      person_titles: jobTitles.length ? jobTitles : undefined,
      per_page: Math.min(limit, 100),
      page: 1,
    };

    const apolloRes = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apolloKey,
      },
      body: JSON.stringify(body),
    });

    if (!apolloRes.ok) {
      const errText = await apolloRes.text();
      let errMsg = errText;
      try { errMsg = JSON.parse(errText).error || errText; } catch {}
      throw new Error(`Apollo: ${errMsg}`);
    }

    const data = await apolloRes.json();
    const people = data.people || [];

    if (!people.length) return res.json({ count: 0, leads: [] });

    const existing = await prisma.lead.findMany({
      where: { campaignId: parseInt(campaignId) },
      select: { name: true, company: true },
    });
    const existingKeys = new Set(existing.map(l => `${l.name}|${l.company}`));

    const toInsert = people
      .filter(p => !existingKeys.has(`${p.name}|${p.organization?.name}`))
      .map(p => ({
        campaignId: parseInt(campaignId),
        bizId: campaign.bizId,
        name: p.name || 'Unknown',
        company: p.organization?.name || '',
        title: p.title || '',
        phone: p.phone_number || '',
        website: p.organization?.website_url || '',
        address: p.city ? `${p.city}, ${p.country}` : '',
        score: 0,
        status: 'new',
        lang: 'EN',
        channels: ['email'],
        last: 'just now',
      }));

    if (!toInsert.length) return res.json({ count: 0, leads: [], msg: 'All leads already exist' });

    await prisma.lead.createMany({ data: toInsert });
    const newTotal = await prisma.lead.count({ where: { campaignId: parseInt(campaignId) } });
    await prisma.campaign.update({ where: { id: parseInt(campaignId) }, data: { leads: newTotal } });

    await prisma.activity.create({
      data: {
        color: 'blue',
        msg: `Imported ${toInsert.length} Apollo contacts for ${campaign.name}`,
        tag: 'Scraper',
      },
    });

    res.json({ count: toInsert.length, total: newTotal });
  } catch (e) { next(e); }
});

// POST /scraper/parallel — run Google Maps + Apollo simultaneously, merge results
router.post('/parallel', requireAuth, async (req, res, next) => {
  try {
    const { campaignId, keyword, city, radius = 10, limit = 100, jobTitles = [], seniority = [] } = req.body;
    if (!campaignId || !city) return res.status(400).json({ error: 'campaignId and city required' });

    const campaign = await prisma.campaign.findUnique({ where: { id: parseInt(campaignId) } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    function norm(s) {
      return (s || '').toLowerCase()
        .replace(/\b(sdn|bhd|berhad|ltd|limited|corp|enterprise|enterprises|trading|industries|industry|group|holdings|holding|malaysia)\b/g, '')
        .replace(/[^a-z0-9]/g, '').trim();
    }

    const [gmapsResult, apolloResult] = await Promise.allSettled([
      keyword
        ? searchGoogleMaps({ query: `${keyword} in ${city}, Malaysia`, limit: Math.min(limit, 300) })
        : Promise.resolve([]),
      (async () => {
        const { getApiKey } = await import('../services/apiKeys.js');
        const apolloKey = await getApiKey('apollo');
        if (!apolloKey) return [];
        const r = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
          body: JSON.stringify({
            q_organization_locations: [`${city}, Malaysia`],
            person_seniorities: seniority.length ? seniority : ['owner', 'founder', 'c_suite', 'director', 'manager'],
            person_titles: jobTitles.length ? jobTitles : undefined,
            per_page: Math.min(limit, 100),
            page: 1,
          }),
        });
        if (!r.ok) return [];
        return (await r.json()).people || [];
      })(),
    ]);

    const gmapsPlaces = gmapsResult.status === 'fulfilled' ? gmapsResult.value : [];
    const apolloPeople = apolloResult.status === 'fulfilled' ? apolloResult.value : [];

    // Build Apollo lookup by normalized company name
    const apolloMap = {};
    for (const p of apolloPeople) {
      const key = norm(p.organization?.name || '');
      if (key && !apolloMap[key]) apolloMap[key] = p;
    }

    // Google Maps leads, merged with Apollo where company names match
    const gmapsLeads = gmapsPlaces.map(place => {
      const base = mapPlaceToLead({ place, campaignId: parseInt(campaignId), bizId: campaign.bizId });
      const key = norm(base.company);
      const match = apolloMap[key];
      if (match) {
        delete apolloMap[key];
        return {
          ...base,
          name: match.name || base.name,
          title: match.title || base.title || 'Business Owner',
          email: match.email || '',
          channels: [...new Set([...(base.channels || []), ...(match.email ? ['email'] : [])])],
          score: 60,
        };
      }
      return { ...base, score: 30 };
    });

    // Apollo-only leads (no Google Maps match)
    const apolloOnlyLeads = Object.values(apolloMap).map(p => ({
      campaignId: parseInt(campaignId),
      bizId: campaign.bizId,
      name: p.name || 'Unknown',
      company: p.organization?.name || '',
      title: p.title || '',
      phone: p.phone_number || '',
      email: p.email || '',
      website: p.organization?.website_url || '',
      address: p.city ? `${p.city}, Malaysia` : '',
      score: 40,
      status: 'scraped',
      lang: 'EN',
      channels: p.email ? ['email'] : [],
      last: 'just now',
    }));

    const allLeads = [...gmapsLeads, ...apolloOnlyLeads];

    // Deduplicate against existing leads
    const existing = await prisma.lead.findMany({
      where: { campaignId: parseInt(campaignId) },
      select: { phone: true, email: true },
    });
    const existingPhones = new Set(existing.map(l => l.phone).filter(Boolean));
    const existingEmails = new Set(existing.map(l => l.email).filter(Boolean));

    const toInsert = allLeads.filter(l =>
      (!l.phone || !existingPhones.has(l.phone)) &&
      (!l.email || !existingEmails.has(l.email))
    );

    if (!toInsert.length) {
      return res.json({ count: 0, total: campaign.leads, gmaps: gmapsPlaces.length, apollo: apolloPeople.length, merged: 0 });
    }

    await prisma.lead.createMany({ data: toInsert });
    const newTotal = await prisma.lead.count({ where: { campaignId: parseInt(campaignId) } });
    await prisma.campaign.update({
      where: { id: parseInt(campaignId) },
      data: { leads: newTotal, status: 'awaiting_approval' },
    });

    await prisma.activity.create({
      data: {
        color: 'green',
        msg: `Scraped ${toInsert.length} leads for "${campaign.name}" (${gmapsPlaces.length} Maps + ${apolloPeople.length} Apollo)`,
        tag: 'Scraper',
      },
    }).catch(() => {});

    // Create Drive sheet async
    setImmediate(async () => {
      try {
        const { createLeadsSheet } = await import('../services/googleDrive.js');
        const leads = await prisma.lead.findMany({ where: { campaignId: parseInt(campaignId) } });
        const sheet = await createLeadsSheet({ campaignName: campaign.name, leads });
        await prisma.campaign.update({
          where: { id: parseInt(campaignId) },
          data: { driveSheetId: sheet.spreadsheetId, driveSheetUrl: sheet.url },
        });
      } catch { /* Drive optional */ }
    });

    res.json({
      count: toInsert.length,
      total: newTotal,
      gmaps: gmapsPlaces.length,
      apollo: apolloPeople.length,
      merged: toInsert.filter(l => l.score === 60).length,
    });
  } catch (e) { next(e); }
});

export default router;
