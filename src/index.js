import express from 'express';
import cors from 'cors';

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
import cron from 'node-cron';
import { runTick } from './engine/campaignRunner.js';
import { clearExpired } from './services/aiCache.js';
import { startQueue } from './services/queue.js';
import { startWorkers } from './workers/index.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, async () => {
  console.log(`KBOOS server running on port ${PORT}`);
  try {
    await startQueue();
    await startWorkers();
    console.log('[Queue] pg-boss workers started');
  } catch (err) {
    console.error('[Queue] Failed to start workers:', err.message);
  }
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
});
