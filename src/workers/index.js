import { registerWorker } from '../services/queue.js';
import { handleValidation } from './validation.js';
import { handleEnrichment } from './enrichment.js';
import { handleAssetGen } from './assetGen.js';
import { handlePersonalize } from './personalize.js';
import { handleEligibility } from './eligibility.js';
import { handleOutreachEmail } from './outreachEmail.js';
import { handleOutreachWa } from './outreachWa.js';
import { handleOutreachVoice } from './outreachVoice.js';
import { handleScrape } from './scrape.js';

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
  console.log('[Workers] All 9 workers registered');
}
