import { getApiKey } from './apiKeys.js';
import prisma from '../db.js';
async function getConfig() {
  const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  const token = await getApiKey('wati');
  const url = await getApiKey('wati_url');
  if (!token) throw Object.assign(new Error('WATI token not configured. Go to Settings → API Keys.'), { status: 400 });
  return { token, baseUrl: url || 'https://live-server.wati.io' };
}

export async function sendMessage({ phone, message }) {
  const { token, baseUrl } = await getConfig();
  const res = await fetch(`${baseUrl}/api/v1/sendSessionMessage/${phone}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageText: message }),
  });
  if (!res.ok) throw new Error(`WATI error: ${res.status}`);
  return res.json();
}

export async function sendTemplate({ phone, templateName, parameters }) {
  const { token, baseUrl } = await getConfig();
  const res = await fetch(`${baseUrl}/api/v1/sendTemplateMessage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsappNumber: phone, template_name: templateName, broadcast_name: 'kboos_blast', parameters }),
  });
  if (!res.ok) throw new Error(`WATI error: ${res.status}`);
  return res.json();
}

export async function testConnection(token, baseUrl) {
  const res = await fetch(`${(baseUrl || 'https://live-server.wati.io')}/api/v1/getContacts?pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}
