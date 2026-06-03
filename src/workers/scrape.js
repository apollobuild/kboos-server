import { searchGoogleMaps, mapPlaceToLead } from '../services/outscraper.js';
import { getApiKey } from '../services/apiKeys.js';
import prisma from '../db.js';

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/\b(sdn|bhd|berhad|ltd|limited|corp|enterprise|enterprises|trading|industries|industry|group|holdings|holding|malaysia)\b/g, '')
    .replace(/[^a-z0-9]/g, '').trim();
}

export async function handleScrape(job) {
  const { campaignId, mode = 'gmaps', keyword, city, limit = 50, jobTitles = [], seniority = [] } = job.data;

  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new Error('Campaign not found');

    const [gmapsResult, apolloResult] = await Promise.allSettled([
      (mode === 'gmaps' || mode === 'parallel') && keyword
        ? searchGoogleMaps({ query: `${keyword} in ${city}, Malaysia`, limit: Math.min(limit, 300) })
        : Promise.resolve([]),
      (mode === 'apollo' || mode === 'parallel')
        ? (async () => {
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
          })()
        : Promise.resolve([]),
    ]);

    const gmapsPlaces = gmapsResult.status === 'fulfilled' ? gmapsResult.value : [];
    const apolloPeople = apolloResult.status === 'fulfilled' ? apolloResult.value : [];

    const apolloMap = {};
    for (const p of apolloPeople) {
      const key = norm(p.organization?.name || '');
      if (key && !apolloMap[key]) apolloMap[key] = p;
    }

    const allLeads = [
      ...gmapsPlaces.map(place => {
        const base = mapPlaceToLead({ place, campaignId, bizId: campaign.bizId });
        const key = norm(base.company);
        const match = apolloMap[key];
        if (match) {
          delete apolloMap[key];
          return {
            ...base,
            name: match.name || base.name,
            title: match.title || 'Business Owner',
            email: match.email || '',
            channels: [...new Set([...(base.channels || []), ...(match.email ? ['email'] : [])])],
            score: 60,
          };
        }
        return { ...base, score: 30 };
      }),
      ...Object.values(apolloMap).map(p => ({
        campaignId,
        bizId: campaign.bizId,
        name: p.name || 'Unknown',
        company: p.organization?.name || '',
        title: p.title || '',
        phone: p.phone_number || '',
        email: p.email || '',
        website: p.organization?.website_url || '',
        address: p.city ? `${p.city}, Malaysia` : '',
        score: 40,
        status: 'new',
        lang: 'EN',
        channels: p.email ? ['email'] : [],
        last: 'just now',
      })),
    ];

    const existing = await prisma.lead.findMany({ where: { campaignId }, select: { phone: true, email: true } });
    const existingPhones = new Set(existing.map(l => l.phone).filter(Boolean));
    const existingEmails = new Set(existing.map(l => l.email).filter(Boolean));

    const toInsert = allLeads.filter(l =>
      (!l.phone || !existingPhones.has(l.phone)) &&
      (!l.email || !existingEmails.has(l.email))
    );

    if (toInsert.length) {
      await prisma.lead.createMany({ data: toInsert });
    }

    const newTotal = await prisma.lead.count({ where: { campaignId } });
    await prisma.campaign.update({ where: { id: campaignId }, data: { leads: newTotal } });

    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'scraped', scrapeComplete: toInsert.length, scrapeTotal: newTotal, scrapedAt: new Date(), lastError: null },
    });

    await prisma.activity.create({
      data: {
        color: 'green',
        msg: `Scraped ${toInsert.length} leads for "${campaign.name}" (${gmapsPlaces.length} Maps + ${apolloPeople.length} Apollo)`,
        tag: 'Scraper',
      },
    }).catch(() => {});

  } catch (err) {
    console.error('[Scrape Worker]', err.message);
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { stage: 'draft', lastError: err.message },
    }).catch(() => {});
    throw err;
  }
}
