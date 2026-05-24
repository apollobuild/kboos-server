import { registerWorker } from '../services/queue.js';
import { handleAutoReply } from './autoReply.js';
import { handleValidation } from './validation.js';
import { handleEnrichment } from './enrichment.js';
import { handleAssetGen } from './assetGen.js';
import { handlePersonalize } from './personalize.js';
import { handleEligibility } from './eligibility.js';
import { handleOutreachEmail } from './outreachEmail.js';
import { handleOutreachWa } from './outreachWa.js';
import { handleOutreachVoice } from './outreachVoice.js';
import { handleScrape } from './scrape.js';
import { handleQualify } from './qualify.js';
import { handleAiScore } from './aiScore.js';
import { handleOptimize } from './optimize.js';

export async function startWorkers() {
  await registerWorker('lead-validation', 4, handleValidation);
  await registerWorker('lead-enrichment', 2, handleEnrichment);
  await registerWorker('ai-asset-gen', 1, handleAssetGen);
  await registerWorker('lead-personalize', 3, handlePersonalize);
  await registerWorker('channel-eligibility', 5, handleEligibility);
  await registerWorker('outreach-email', 5, handleOutreachEmail);
  await registerWorker('outreach-wa', 3, handleOutreachWa);
  await registerWorker('outreach-voice', 2, handleOutreachVoice);
  await registerWorker('lead-scrape', 2, handleScrape);
  await registerWorker('lead-qualify', 4, handleQualify);
  await registerWorker('lead-ai-score', 3, handleAiScore);
  await registerWorker('optimization-loop', 1, handleOptimize);
  await registerWorker('auto-reply', 3, handleAutoReply);
  console.log('[Workers] All 13 workers registered');
}
