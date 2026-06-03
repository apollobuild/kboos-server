import { sendEmail } from '../services/sendgrid.js';
import { getTenantConfig, formatCurrencyServer } from '../services/tenantConfig.js';
import prisma from '../db.js';

const COLOR_MAP = {
  blue: '#3b82f6', green: '#22c55e', amber: '#f59e0b', red: '#ef4444',
  violet: '#8b5cf6', rose: '#f43f5e', emerald: '#10b981', teal: '#14b8a6',
  orange: '#f97316', indigo: '#6366f1', pink: '#ec4899', cyan: '#06b6d4',
};

function resolveColor(color) {
  if (!color) return '#3b82f6';
  if (color.startsWith('#') || color.startsWith('rgb')) return color;
  return COLOR_MAP[color.toLowerCase()] || '#3b82f6';
}

export async function buildReportData(bizId) {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);

  const [biz, campaigns, actions, replies, meetings, leads] = await Promise.all([
    prisma.business.findUnique({ where: { id: bizId } }),
    prisma.campaign.findMany({ where: { bizId } }),
    prisma.campaignAction.findMany({
      where: { campaign: { bizId }, sentAt: { gte: weekStart }, status: 'sent' },
      select: { type: true },
    }),
    prisma.reply.findMany({
      where: { bizId, createdAt: { gte: weekStart } },
      select: { id: true },
    }),
    prisma.meetingLog.findMany({
      where: { bizId, createdAt: { gte: weekStart } },
      select: { id: true, outcome: true, revenue: true },
    }),
    prisma.lead.findMany({
      where: { bizId },
      select: { id: true, status: true, score: true, dealValue: true },
    }),
  ]);

  if (!biz) return null;

  const emailSent = actions.filter(a => a.type === 'email').length;
  const waSent = actions.filter(a => a.type === 'wa').length;
  const voiceSent = actions.filter(a => a.type === 'voice').length;
  const totalSent = emailSent + waSent + voiceSent;
  const replyCount = replies.length;
  const replyRate = totalSent > 0 ? ((replyCount / totalSent) * 100).toFixed(1) : '0.0';
  const hotLeads = leads.filter(l => (l.score || 0) >= 70 || l.status === 'hot').length;
  const meetingsBooked = meetings.length;

  const pipeline = {
    'New': leads.filter(l => ['new', 'personalizing'].includes(l.status)).length,
    'Contacted': leads.filter(l => l.status === 'contacted').length,
    'Replied': leads.filter(l => l.status === 'replied').length,
    'Hot': leads.filter(l => l.status === 'hot' || (l.score || 0) >= 70).length,
    'Meeting': leads.filter(l => l.status === 'meeting_booked').length,
    'Won': leads.filter(l => (l.dealValue || 0) > 0).length,
  };

  const closedRevenue = meetings
    .filter(m => m.outcome === 'completed')
    .reduce((s, m) => s + (m.revenue || 0), 0);
  const pipelineRevenue = leads.reduce((s, l) => s + (l.dealValue || 0), 0);

  return {
    biz, weekStart,
    campaigns: campaigns.length,
    activeCampaigns: campaigns.filter(c => c.status === 'active').length,
    totalLeads: leads.length,
    emailSent, waSent, voiceSent, totalSent,
    replyCount, replyRate,
    hotLeads, meetingsBooked,
    pipeline, closedRevenue, pipelineRevenue,
  };
}

export function buildHtml(data, tc = {}) {
  const hex = resolveColor(data.biz.color);
  const weekOf = data.weekStart.toLocaleDateString('en-MY', { day: 'numeric', month: 'long' });
  const sentOn = new Date().toLocaleDateString('en-MY', { day: 'numeric', month: 'long', year: 'numeric' });

  const maxPipe = Math.max(...Object.values(data.pipeline), 1);
  const pipeRows = Object.entries(data.pipeline)
    .filter(([, v]) => v > 0)
    .map(([label, count]) => {
      const bars = Math.max(1, Math.round((count / maxPipe) * 18));
      return `<tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#555;width:80px;font-weight:500">${label}</td>
        <td style="padding:4px 0;font-family:'Courier New',monospace;font-size:11px;letter-spacing:-1px">
          <span style="color:${hex}">${'█'.repeat(bars)}</span><span style="color:#ddd">${'░'.repeat(18 - bars)}</span>
        </td>
        <td style="padding:4px 0 4px 10px;font-size:13px;font-weight:700;color:#222">${count}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" style="font-size:12px;color:#aaa;padding:4px 0">No lead data yet</td></tr>';

  const statCell = (value, label, bg, color) =>
    `<td style="text-align:center;padding:14px 8px;background:${bg};border-radius:10px">
      <div style="font-size:26px;font-weight:700;color:${color};line-height:1">${value}</div>
      <div style="font-size:11px;color:#999;margin-top:4px">${label}</div>
    </td><td width="8"></td>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Report — ${data.biz.name}</title></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 16px">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

  <tr><td style="background:${hex};padding:32px 36px 28px">
    <div style="font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:0.15em;text-transform:uppercase;margin-bottom:8px">Weekly Campaign Report</div>
    <div style="font-size:26px;font-weight:700;color:#fff;margin-bottom:4px">${data.biz.name}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.75)">Week of ${weekOf} · Sent ${sentOn}</div>
  </td></tr>

  <tr><td style="padding:28px 36px 0">
    <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;font-weight:600">Campaign Overview</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${statCell(data.activeCampaigns, 'Active Campaigns', '#f8f9fa', hex)}
      ${statCell(data.campaigns, 'Total Campaigns', '#f8f9fa', '#333')}
      ${statCell(data.totalLeads.toLocaleString(), 'Total Leads', '#f8f9fa', '#333')}
    </tr></table>
  </td></tr>

  <tr><td style="padding:24px 36px 0">
    <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;font-weight:600">Sent This Week</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${statCell(data.emailSent.toLocaleString(), '✉ Emails', '#eff6ff', '#3b82f6')}
      ${statCell(data.waSent.toLocaleString(), '💬 WhatsApp', '#f0fdf4', '#22c55e')}
      ${statCell(data.voiceSent.toLocaleString(), '📞 Voice', '#fffbeb', '#f59e0b')}
      ${statCell(data.totalSent.toLocaleString(), 'Total Sent', '#f8f9fa', hex)}
    </tr></table>
  </td></tr>

  <tr><td style="padding:24px 36px 0">
    <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;font-weight:600">Engagement</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${statCell(data.replyCount, 'Replies', '#f8f9fa', '#333')}
      ${statCell(`${data.replyRate}%`, 'Reply Rate', '#f8f9fa', hex)}
      ${statCell(data.hotLeads, '🔥 Hot Leads', '#fffbeb', '#f59e0b')}
      ${statCell(data.meetingsBooked, '📅 Meetings', '#f0fdf4', '#22c55e')}
    </tr></table>
  </td></tr>

  <tr><td style="padding:24px 36px 0">
    <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;font-weight:600">Lead Pipeline Breakdown</div>
    <table cellpadding="0" cellspacing="0">${pipeRows}</table>
  </td></tr>

  ${(data.closedRevenue > 0 || data.pipelineRevenue > 0) ? `
  <tr><td style="padding:24px 36px 0">
    <div style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;font-weight:600">Revenue</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${statCell(formatCurrencyServer(data.closedRevenue, tc.currency || 'MYR'), 'Closed This Week', '#f0fdf4', '#22c55e')}
      ${statCell(formatCurrencyServer(data.pipelineRevenue, tc.currency || 'MYR'), 'Total Pipeline', '#f8f9fa', '#333')}
    </tr></table>
  </td></tr>` : ''}

  <tr><td style="padding:28px 36px">
    <div style="border-top:1px solid #eee;padding-top:20px;font-size:11px;color:#aaa;text-align:center;line-height:1.8">
      Powered by <strong style="color:${hex}">KBOOS</strong> by KOBIS Berhad &nbsp;·&nbsp;
      Auto-sent every Monday at 8:00 AM (${tc.timezone || 'UTC'})
    </div>
  </td></tr>

</table></td></tr></table>
</body></html>`;
}

export async function handleWeeklyReport({ data }) {
  const { bizId, force } = data;

  const reportData = await buildReportData(bizId);
  if (!reportData) return;

  const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  const notif = settings?.notifications || {};
  const reportConfig = notif.weeklyReport || {};

  if (!reportConfig.enabled && !force) return;

  const biz = reportData.biz;
  const tc = await getTenantConfig(biz.tenantId);
  const html = buildHtml(reportData, tc);
  const weekOf = reportData.weekStart.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' });
  const subject = `📊 Weekly Report: ${reportData.biz.name} — w/o ${weekOf}`;

  const clientUsers = await prisma.user.findMany({
    where: { bizId, role: 'client' },
    select: { email: true },
  });

  const recipients = clientUsers.map(u => u.email).filter(Boolean);

  if (reportConfig.includeTeam !== false) {
    (notif.teamEmail || []).forEach(e => { if (e && !recipients.includes(e)) recipients.push(e); });
  }

  if (recipients.length === 0) {
    console.log(`[WeeklyReport] No recipients for ${reportData.biz.name} — skipping`);
    return;
  }

  for (const to of recipients) {
    await sendEmail({ to, subject, body: html, fromName: reportData.biz.name }).catch(err =>
      console.error(`[WeeklyReport] Send failed to ${to}:`, err.message)
    );
  }

  console.log(`[WeeklyReport] ✓ ${reportData.biz.name} → ${recipients.length} recipient(s)`);
}
