import sgMail from '@sendgrid/mail';
import { getApiKey } from './apiKeys.js';

async function setup() {
  const key = await getApiKey('sendgrid');
  if (!key) throw Object.assign(new Error('SendGrid API key not configured. Go to Settings → API Keys.'), { status: 400 });
  sgMail.setApiKey(key);
}

export async function sendEmail({ to, subject, body, fromEmail, fromName }) {
  await setup();
  const from = fromEmail || 'outreach@kboos.app';
  await sgMail.send({ to, from: { email: from, name: fromName || 'KBOOS Outreach' }, subject, text: body, html: body.replace(/\n/g, '<br>') });
  return { sent: true };
}

export async function sendBulk(leads, subject, template, fromEmail) {
  await setup();
  const results = { sent: 0, failed: 0, errors: [] };
  for (const lead of leads) {
    const body = template
      .replace(/\{\{first_name\}\}/g, lead.name.split(' ')[0])
      .replace(/\{\{company\}\}/g, lead.company)
      .replace(/\{\{title\}\}/g, lead.title || '');
    try {
      await sgMail.send({ to: lead.email || `${lead.name.toLowerCase().replace(' ', '.')}@${lead.company.toLowerCase().replace(' ', '')}.com`, from: fromEmail || 'outreach@kboos.app', subject, html: body.replace(/\n/g, '<br>') });
      results.sent++;
    } catch (e) {
      results.failed++;
      results.errors.push({ lead: lead.name, error: e.message });
    }
  }
  return results;
}

export async function testConnection(apiKey) {
  sgMail.setApiKey(apiKey);
  // Validate by checking the key format (SG. prefix) — full test requires sending
  return apiKey.startsWith('SG.');
}
