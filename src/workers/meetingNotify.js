import { PrismaClient } from '@prisma/client';
import { sendMessage as sendWa } from '../services/wati.js';
import { sendEmail } from '../services/sendgrid.js';
import { getTenantConfig } from '../services/tenantConfig.js';

const prisma = new PrismaClient();

const REMINDER_LABELS = {
  booking_confirmation: 'confirmed',
  t24h: 'tomorrow',
  t3h: 'today',
  t1h: 'in 1 hour',
  t15min: 'in 15 minutes',
};

function formatDate(d, timeZone = 'UTC') {
  if (!d) return 'TBD';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone,
  }).format(new Date(d));
}

function buildMessages(type, meeting, timeZone = 'UTC') {
  const { leadName, bizName, meetingType, meetingDate } = meeting;
  const dateStr = formatDate(meetingDate, timeZone);

  if (type === 'booking_confirmation') {
    return {
      leadWa: `Hi ${leadName}! ✅ Your meeting with ${bizName} is confirmed.\n\n📅 ${dateStr}\n📋 Type: ${meetingType}\n\nWe look forward to speaking with you!`,
      leadEmail: `<p>Hi ${leadName},</p><p>Your meeting with <strong>${bizName}</strong> is confirmed for <strong>${dateStr}</strong>.</p><p>See you then! 😊</p>`,
      leadSubject: `Meeting Confirmed: ${bizName} — ${dateStr}`,
      teamWa: `📅 New meeting booked!\n👤 ${leadName}\n🏢 ${bizName}\n📆 ${dateStr}\n📋 ${meetingType}`,
      teamEmail: `<p>New meeting booked:</p><ul><li><strong>Lead:</strong> ${leadName}</li><li><strong>Business:</strong> ${bizName}</li><li><strong>Date:</strong> ${dateStr}</li><li><strong>Type:</strong> ${meetingType}</li></ul>`,
      teamSubject: `New Meeting: ${leadName} — ${dateStr}`,
    };
  }
  if (type === 't24h') {
    return {
      leadWa: `Hi ${leadName}! 👋 Reminder — your meeting with ${bizName} is tomorrow.\n\n📅 ${dateStr}\n\nSee you then!`,
      leadEmail: `<p>Hi ${leadName},</p><p>Just a reminder — your meeting with <strong>${bizName}</strong> is <strong>tomorrow at ${dateStr}</strong>.</p>`,
      leadSubject: `Reminder: Meeting Tomorrow — ${bizName}`,
      teamWa: `⏰ Meeting tomorrow\n👤 ${leadName}\n🏢 ${bizName}\n📆 ${dateStr}`,
      teamEmail: `<p>Meeting tomorrow: <strong>${leadName}</strong> (${bizName}) at <strong>${dateStr}</strong>.</p>`,
      teamSubject: `Meeting Tomorrow: ${leadName}`,
    };
  }
  if (type === 't3h') {
    return {
      leadWa: `Good morning, ${leadName}! ☀️ Your meeting with ${bizName} is today.\n\n📅 ${dateStr}\n\nLooking forward to it!`,
      leadEmail: `<p>Hi ${leadName},</p><p>Your meeting with <strong>${bizName}</strong> is today at <strong>${dateStr}</strong>.</p>`,
      leadSubject: `Your Meeting is Today — ${bizName}`,
      teamWa: `⏰ Meeting today in ~3h\n👤 ${leadName}\n🏢 ${bizName}\n📆 ${dateStr}`,
      teamEmail: `<p>Meeting in ~3 hours: <strong>${leadName}</strong> at <strong>${dateStr}</strong>.</p>`,
      teamSubject: `Meeting Today: ${leadName}`,
    };
  }
  if (type === 't1h') {
    return {
      leadWa: `Hi ${leadName}! ⏰ Your meeting with ${bizName} is in 1 hour.\n\n📅 ${dateStr}\n\nSee you soon!`,
      leadEmail: `<p>Hi ${leadName},</p><p>Your meeting with <strong>${bizName}</strong> starts in <strong>1 hour</strong> at ${dateStr}.</p>`,
      leadSubject: `Meeting in 1 Hour — ${bizName}`,
      teamWa: `⏰ Meeting in 1 hour!\n👤 ${leadName}\n🏢 ${bizName}\n📆 ${dateStr}`,
      teamEmail: `<p>Meeting in 1 hour: <strong>${leadName}</strong> at <strong>${dateStr}</strong>.</p>`,
      teamSubject: `1 Hour: ${leadName}`,
    };
  }
  if (type === 't15min') {
    return {
      leadWa: `Hi ${leadName}! 🚀 Your meeting with ${bizName} starts in 15 minutes!\n\n📅 ${dateStr}`,
      leadEmail: null,
      leadSubject: null,
      teamWa: `🚀 Meeting in 15 min!\n👤 ${leadName}\n🏢 ${bizName}\n📆 ${dateStr}`,
      teamEmail: null,
      teamSubject: null,
    };
  }
  return {};
}

export async function handleMeetingNotify({ data }) {
  const { meetingId, type } = data;

  const meeting = await prisma.meetingLog.findUnique({ where: { id: meetingId } });
  if (!meeting) return;
  if (['completed', 'no_show', 'cancelled'].includes(meeting.outcome)) return;

  const tc = await getTenantConfig(meeting.tenantId);
  const timeZone = tc.timezone || 'UTC';

  const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  const notif = settings?.notifications || {};
  const reminderConfig = notif.reminderSequence || {};

  // Booking confirmation always sends; other types respect config
  if (type !== 'booking_confirmation' && reminderConfig[type] === false) return;

  const msgs = buildMessages(type, meeting, timeZone);
  const teamWhatsApp = notif.teamWhatsApp || [];
  const teamEmail = notif.teamEmail || [];

  // Lead notifications
  if (meeting.leadPhone && msgs.leadWa) {
    await sendWa({ phone: meeting.leadPhone, message: msgs.leadWa }).catch(() => {});
  }
  if (meeting.leadEmail && msgs.leadEmail && msgs.leadSubject) {
    await sendEmail({ to: meeting.leadEmail, subject: msgs.leadSubject, body: msgs.leadEmail }).catch(() => {});
  }

  // Team notifications
  for (const phone of teamWhatsApp) {
    await sendWa({ phone, message: msgs.teamWa }).catch(() => {});
  }
  for (const email of teamEmail) {
    if (msgs.teamEmail && msgs.teamSubject) {
      await sendEmail({ to: email, subject: msgs.teamSubject, body: msgs.teamEmail }).catch(() => {});
    }
  }

  console.log(`[MeetingNotify] Sent ${type} for meeting ${meetingId} (${meeting.leadName})`);
}
