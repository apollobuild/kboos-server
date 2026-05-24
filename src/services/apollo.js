import { getApiKey } from './apiKeys.js';

const BASE = 'https://api.apollo.io/api/v1';

async function getKey() {
  const key = await getApiKey('apollo');
  if (!key) throw Object.assign(new Error('Apollo API key not configured'), { status: 400 });
  return key;
}

function parseApolloError(text) {
  try { return JSON.parse(text).error || text; } catch { return text; }
}

// Search for decision makers in a city (used during parallel scraping)
export async function searchPeople({ city, jobTitles = [], seniorities = [], limit = 100, country = 'Malaysia' }) {
  const key = await getKey();
  const res = await fetch(`${BASE}/mixed_people/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify({
      q_organization_locations: city ? [`${city}, ${country}`] : [country],
      person_seniorities: seniorities.length ? seniorities : ['owner', 'founder', 'c_suite', 'director', 'manager'],
      person_titles: jobTitles.length ? jobTitles : undefined,
      per_page: Math.min(limit, 100),
      page: 1,
    }),
  });
  if (!res.ok) throw new Error(`Apollo: ${parseApolloError(await res.text())}`);
  const data = await res.json();
  return data.people || [];
}

// Enrich a single lead by company name (used during enrichment phase)
export async function enrichLead({ companyName, city, country = 'Malaysia' }) {
  const key = await getKey();
  const res = await fetch(`${BASE}/mixed_people/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify({
      q_organization_name: companyName,
      q_organization_locations: city ? [`${city}, ${country}`] : [country],
      person_seniorities: ['owner', 'founder', 'c_suite', 'director', 'manager'],
      per_page: 1,
      page: 1,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const p = data.people?.[0];
  if (!p) return null;
  return {
    decisionMakerName: p.name || null,
    email: p.email || null,
    title: p.title || null,
    phone: p.phone_number || null,
  };
}

export async function testConnection(apiKey) {
  const res = await fetch(`${BASE}/auth/health`, {
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
  });
  return res.ok;
}
