import './config/env.js'; // validate required env vars before anything else
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { sendMessageToSession, getWarmupLimit } from './services/openwa.js';

import authRoutes from './routes/auth.js';
import businessRoutes from './routes/businesses.js';
import campaignRoutes from './routes/campaigns.js';
import leadRoutes from './routes/leads.js';
import replyRoutes from './routes/replies.js';
import activityRoutes from './routes/activity.js';
import aiRoutes from './routes/ai.js';
import emailRoutes from './routes/email.js';
import whatsappRoutes from './routes/whatsapp.js';
import settingsRoutes from './routes/settings.js';
import walletRoutes from './routes/wallet.js';
import scraperRoutes from './routes/scraper.js';
import voiceRoutes from './routes/voice.js';
import portalRoutes from './routes/portal.js';
import demoRoutes from './routes/demo.js';
import enrichmentRoutes from './routes/enrichment.js';
import webhookRoutes from './routes/webhooks.js';
import onboardRoutes from './routes/onboard.js';
import sequenceRoutes from './routes/sequences.js';
import pipelineRoutes from './routes/pipeline.js';
import meetingsRoutes from './routes/meetings.js';
import analyticsRoutes from './routes/analytics.js';
import searchRoutes from './routes/search.js';
import reportsRoutes from './routes/reports.js';
import tenantRoutes from './routes/tenants.js';
import openwaRoutes from './routes/openwa.js';
import metaWaRoutes from './routes/metaWa.js';
import internalRoutes from './routes/internal.js';
import cron from 'node-cron';
import { runTick } from './engine/campaignRunner.js';
import { clearExpired } from './services/aiCache.js';
import { startQueue, enqueue, queueState } from './services/queue.js';
import { startWorkers } from './workers/index.js';
import prisma from './db.js';
async function scanMeetingReminders() {
  try {
    const now = new Date();
    const in26h = new Date(now.getTime() + 26 * 3600000);
    const upcoming = await prisma.meetingLog.findMany({
      where: { meetingDate: { gte: now, lte: in26h }, outcome: { notIn: ['completed', 'no_show', 'cancelled'] } },
    });
    for (const m of upcoming) {
      const hoursUntil = (new Date(m.meetingDate) - now) / 3600000;
      const sent = Array.isArray(m.remindersSent) ? m.remindersSent : [];
      const toSend = [];
      if (!sent.includes('t24h') && hoursUntil <= 25 && hoursUntil > 4) toSend.push('t24h');
      if (!sent.includes('t3h') && hoursUntil <= 3.5 && hoursUntil > 1.2) toSend.push('t3h');
      if (!sent.includes('t1h') && hoursUntil <= 1.2 && hoursUntil > 0.3) toSend.push('t1h');
      if (!sent.includes('t15min') && hoursUntil <= 0.3 && hoursUntil > 0) toSend.push('t15min');
      for (const type of toSend) {
        const newSent = [...sent, type];
        await Promise.all([
          enqueue('meeting-notify', { meetingId: m.id, type }).catch(() => {}),
          prisma.meetingLog.update({ where: { id: m.id }, data: { remindersSent: newSent } }),
        ]);
        sent.push(type);
      }
    }
    if (upcoming.length > 0) console.log(`[Meetings] Scanned ${upcoming.length} upcoming meetings`);
  } catch (err) {
    console.error('[Meetings] Reminder scan error:', err.message);
  }
}

async function runWASequenceStep() {
  try {
    const campaigns = await prisma.wAConnectCampaign.findMany({
      where: { status: 'active' },
    });
    for (const c of campaigns) {
      const seq = Array.isArray(c.sequence) ? c.sequence : [];
      const currentStep = c.currentStep || 1;
      if (currentStep >= seq.length) continue; // all steps done

      const nextStep = seq[currentStep]; // 0-indexed
      if (!nextStep) continue;

      const statuses = Array.isArray(c.leadStatuses) ? c.leadStatuses : [];
      const leads = Array.isArray(c.leads) ? c.leads : [];

      // Find leads who completed step currentStep but not currentStep+1
      // and whose last send was >= nextStep.day days ago
      const now = Date.now();
      const due = statuses.filter(s => {
        if (s.optedOut) return false;
        if (s.step >= currentStep + 1) return false;
        if (s.step < currentStep) return false;
        const daysSince = (now - new Date(s.sentAt).getTime()) / 86400000;
        return daysSince >= (nextStep.day - (seq[currentStep - 1]?.day || 1));
      });

      if (due.length === 0) continue;

      // Get session
      const session = await prisma.openWASession.findUnique({ where: { id: c.sessionId } }).catch(() => null);
      if (!session || session.status !== 'connected') continue;

      // Send next step to due leads (up to daily remaining)
      const eff = session.warmupEnabled ? getWarmupLimit(session.warmupWeek) : session.dailyLimit;
      const remaining = eff - session.sentToday;
      const toSend = due.slice(0, Math.min(remaining, c.sendLimit));

      let sent = 0;
      for (const leadStatus of toSend) {
        const lead = leads.find(l => l.phone === leadStatus.phone);
        if (!lead) continue;
        const msg = (nextStep.message || '').replace(/\{name\}/gi, lead.name || '').replace(/\{company\}/gi, lead.company || '').replace(/\{first_name\}/gi, (lead.name || '').split(' ')[0]);
        try {
          await sendMessageToSession(session.sessionName, lead.phone, msg);
          const idx = statuses.findIndex(s => s.phone === lead.phone);
          if (idx >= 0) statuses[idx] = { ...statuses[idx], step: currentStep + 1, sentAt: new Date().toISOString() };
          sent++;
          await new Promise(r => setTimeout(r, 30000));
        } catch { }
      }

      if (sent > 0) {
        await prisma.openWASession.update({ where: { id: session.id }, data: { sentToday: { increment: sent } } });
        await prisma.wAConnectCampaign.update({ where: { id: c.id }, data: { leadStatuses: statuses } });
        console.log(`[WA Sequence] Campaign ${c.id} step ${currentStep + 1}: sent ${sent}`);
      }
    }
  } catch (err) {
    console.error('[WA Sequence] Error:', err.message);
  }
}

const app = express();
app.set('trust proxy', 1); // Railway runs behind a proxy — required for rate limiting to see real client IPs
const PORT = process.env.PORT || 4000;

const allowedOrigins = process.env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? (origin, cb) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  } : '*',
  credentials: true,
}));

// Rate limiting — protect auth and public endpoints from abuse
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts, try again in 15 minutes' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, skip: (req) => req.path === '/health' });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  version: process.env.npm_package_version || '1.0.0',
  queue: queueState,
  // Booleans only — never the secret values — so config can be verified safely
  config: {
    metaWaWebhookSecret: !!(process.env.META_WA_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET),
    frontendUrl: !!process.env.FRONTEND_URL,
    jwtSecret: !!process.env.JWT_SECRET,
    encryptionKey: !!process.env.ENCRYPTION_KEY,
  },
}));

// Diagnostic view: job states + pipeline progress, readable from a browser
app.get('/health/pipeline', async (_, res) => {
  try {
    const jobs = await prisma.$queryRaw`
      SELECT name, state, COUNT(*)::int AS count
      FROM pgboss.job
      WHERE name IN ('lead-ai-score', 'lead-personalize', 'ai-asset-gen')
      GROUP BY name, state ORDER BY name, state`;
    const archived = await prisma.$queryRaw`
      SELECT name, state, COUNT(*)::int AS count
      FROM pgboss.archive
      WHERE name IN ('lead-ai-score', 'lead-personalize', 'ai-asset-gen')
      GROUP BY name, state ORDER BY name, state`.catch(() => []);
    const pipelines = await prisma.$queryRaw`
      SELECT "campaignId", stage, "aiScoreTotal", "aiScoreComplete",
             "personalizeTotal", "personalizeComplete", "lastError"
      FROM "CampaignPipeline" ORDER BY "campaignId"`;
    const recentFailures = await prisma.$queryRaw`
      SELECT name, state, data->>'campaignId' AS campaign, output, "completedOn"
      FROM pgboss.job
      WHERE name IN ('lead-ai-score', 'lead-personalize', 'ai-asset-gen')
        AND state IN ('failed', 'retry')
      ORDER BY "completedOn" DESC NULLS LAST
      LIMIT 5`.catch(() => []);
    const enrichment = await prisma.$queryRaw`
      SELECT "campaignId", COALESCE("enrichmentNote", '(no note)') AS note, COUNT(*)::int AS count
      FROM "Lead"
      WHERE enriched = true
      GROUP BY "campaignId", "enrichmentNote"
      ORDER BY "campaignId", count DESC`.catch(() => []);
    res.json({ queue: queueState, jobs, archived, pipelines, recentFailures, enrichment });
  } catch (e) {
    res.status(500).json({ error: e.message, queue: queueState });
  }
});

app.use('/auth/login', authLimiter);
app.use(apiLimiter);
app.use('/auth', authRoutes);
app.use('/businesses', businessRoutes);
app.use('/campaigns', campaignRoutes);
app.use('/leads', leadRoutes);
app.use('/replies', replyRoutes);
app.use('/activity', activityRoutes);
app.use('/ai', aiRoutes);
app.use('/email', emailRoutes);
app.use('/whatsapp', whatsappRoutes);
app.use('/settings', settingsRoutes);
app.use('/wallet', walletRoutes);
app.use('/scraper', scraperRoutes);
app.use('/voice', voiceRoutes);
app.use('/portal', portalRoutes);
app.use('/demo', demoRoutes);
app.use('/enrichment', enrichmentRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/onboard', onboardRoutes);
app.use('/sequences', sequenceRoutes);
app.use('/pipeline', pipelineRoutes);
app.use('/meetings', meetingsRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/search', searchRoutes);
app.use('/reports', reportsRoutes);
app.use('/tenants', tenantRoutes);
app.use('/openwa', openwaRoutes);
app.use('/meta-wa', metaWaRoutes);
app.use('/webhooks/meta-wa', metaWaRoutes);
app.use('/internal/debug', internalRoutes);

app.use((err, req, res, next) => {
  // Translate Prisma errors to user-friendly messages — never expose raw Prisma output
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'A record with that value already exists' });
  }
  if (err.code === 'P2003') {
    return res.status(409).json({ error: 'Cannot complete this action because related records exist' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found' });
  }
  if (err.code === 'P2016' || err.code === 'P2019') {
    return res.status(400).json({ error: 'Invalid data provided' });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start queue BEFORE accepting requests to avoid race conditions.
// Retry on failure — a transient DB hiccup at boot must not leave the
// queue dead for the whole life of the deployment.
(async () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await startQueue();
      await startWorkers();
      queueState.workersRegistered = true;
      console.log('[Queue] pg-boss workers started');
      return;
    } catch (err) {
      queueState.error = err.message;
      console.error(`[Queue] Failed to start workers (attempt ${attempt}/5):`, err.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  console.error('[Queue] Workers permanently failed to start — background jobs will NOT run');
})();

app.listen(PORT, () => {
  console.log(`KBOOS server running on port ${PORT}`);
  // Campaign execution engine — every hour on the hour
  cron.schedule('0 * * * *', () => {
    console.log('[Engine] Hourly tick');
    runTick().catch(err => console.error('[Engine] Tick error:', err.message));
  });
  // Startup tick after 10s (catch up on any missed hours)
  setTimeout(() => runTick().catch(err => console.error('[Engine] Startup tick error:', err.message)), 10000);
  // Nightly cache cleanup at 2am KL (6pm UTC)
  cron.schedule('0 18 * * *', () => {
    clearExpired().then(n => console.log(`[Cache] Cleared ${n} expired AI insight entries`)).catch(() => {});
  });
  // Meeting reminders — scan every 15 minutes
  cron.schedule('*/15 * * * *', () => scanMeetingReminders());
  setTimeout(() => scanMeetingReminders(), 15000);
  // WA Connect sequence scheduler — runs every 2 hours
  cron.schedule('0 */2 * * *', () => {
    runWASequenceStep().catch(err => console.error('[WA Sequence] Cron error:', err.message));
  });
  // Weekly client reports — every Monday at 8am KL (UTC 0am Monday = UTC+8 8am Monday)
  cron.schedule('0 0 * * 1', async () => {
    console.log('[WeeklyReport] Monday trigger — queuing reports for all businesses');
    try {
      const bizIds = await prisma.user.findMany({
        where: { role: 'client', bizId: { not: null } },
        select: { bizId: true }, distinct: ['bizId'],
      });
      for (const { bizId } of bizIds) {
        await enqueue('weekly-report', { bizId }).catch(() => {});
      }
      console.log(`[WeeklyReport] Queued ${bizIds.length} report(s)`);
    } catch (err) {
      console.error('[WeeklyReport] Cron error:', err.message);
    }
  });
});
