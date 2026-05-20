import { getApiKey } from './apiKeys.js';
import { logScraper } from './costLogger.js';

const BASE = 'https://api.app.outscraper.com';

async function getKey() {
  const key = await getApiKey('outscraper');
  if (!key) throw Object.assign(new Error('Outscraper API key not configured'), { status: 400 });
  return key;
}

export async function searchGoogleMaps({ query, limit = 50 }) {
  const key = await getKey();

  // Start async task
  const startRes = await fetch(`${BASE}/maps/search-v3`, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, async: true, language: 'en', region: 'MY' }),
  });
  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`Outscraper error: ${err}`);
  }
  const task = await startRes.json();
  const taskId = task.id;
  if (!taskId) throw new Error('Outscraper did not return a task ID');

  // Poll until done (max 90s, every 6s = 15 tries)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 6000));
    const pollRes = await fetch(`${BASE}/requests/${taskId}`, {
      headers: { 'X-API-KEY': key },
    });
    if (!pollRes.ok) continue;
    const result = await pollRes.json();
    if (result.status === 'Success' && result.data) {
      const places = result.data.flat().filter(p => p && p.name);
      logScraper({ records: places.length });
      return places;
    }
    if (result.status === 'Error') throw new Error('Outscraper task failed');
    // status is Pending/Processing — continue polling
  }
  throw new Error('Outscraper timed out after 90 seconds');
}

export function mapPlaceToLead({ place, campaignId, bizId }) {
  const phone = place.phone_number || place.phone || '';
  const channels = [];
  if (phone) channels.push('whatsapp');
  channels.push('email');

  return {
    campaignId,
    bizId,
    name: place.name,
    company: place.name,
    title: 'Business Owner',
    phone,
    website: place.site || place.website || '',
    address: place.full_address || place.address || '',
    score: 0,
    status: 'new',
    lang: 'EN',
    channels,
    last: 'just now',
  };
}

export async function testConnection(apiKey) {
  const res = await fetch(`${BASE}/maps/search-v3?query=test&limit=1`, {
    headers: { 'X-API-KEY': apiKey },
  });
  return res.status !== 401;
}
