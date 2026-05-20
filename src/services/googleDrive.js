import { google } from 'googleapis';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function getAuth() {
  const s = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  const key = s?.driveServiceAccountKey;
  if (!key) throw Object.assign(new Error('Google Drive not configured — upload service account JSON in Settings → Drive'), { status: 400 });
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  });
}

const HEADERS = ['Name', 'Company', 'Title', 'Phone', 'Email', 'Website', 'Address', 'Status', 'Score', 'Enriched', 'Channels'];

function leadToRow(l) {
  return [
    l.name, l.company, l.title || '', l.phone || '', l.email || '',
    l.website || '', l.address || '', l.status, String(l.score || 0),
    l.enriched ? 'Yes' : 'No', (l.channels || []).join(', '),
  ];
}

export async function createLeadsSheet({ campaignName, leads }) {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const response = await sheets.spreadsheets.create({
    resource: {
      properties: { title: `KBOOS — ${campaignName} Leads` },
      sheets: [{
        properties: { title: 'Leads' },
        data: [{
          startRow: 0, startColumn: 0,
          rowData: [
            { values: HEADERS.map(v => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { textFormat: { bold: true } } })) },
            ...leads.map(l => ({ values: leadToRow(l).map(v => ({ userEnteredValue: { stringValue: v } })) })),
          ],
        }],
      }],
    },
  });

  const spreadsheetId = response.data.spreadsheetId;
  await drive.permissions.create({
    fileId: spreadsheetId,
    resource: { role: 'reader', type: 'anyone' },
  }).catch(() => {});

  return {
    spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

export async function syncLeads({ spreadsheetId, leads }) {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Leads!A2',
    valueInputOption: 'RAW',
    resource: { values: leads.map(leadToRow) },
  });
}

export async function testConnection(serviceAccountKey) {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.about.get({ fields: 'user' });
  return !!res.data.user;
}
