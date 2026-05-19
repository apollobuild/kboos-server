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

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => console.log(`KBOOS server running on port ${PORT}`));
