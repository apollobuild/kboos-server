// Anthropic pricing USD per token (as of 2025)
import prisma from '../db.js';
const CLAUDE_RATES = {
  'claude-sonnet-4-6':        { input: 3.00  / 1_000_000, output: 15.00 / 1_000_000 },
  'claude-haiku-4-5-20251001': { input: 0.80  / 1_000_000, output:  4.00 / 1_000_000 },
  'claude-opus-4-7':           { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
};

export async function logClaude({ model, inputTokens, outputTokens, action, tenantId = 'default' }) {
  const rates = CLAUDE_RATES[model] || CLAUDE_RATES['claude-sonnet-4-6'];
  const costUsd = (inputTokens * rates.input) + (outputTokens * rates.output);
  await prisma.apiUsageLog.create({
    data: {
      service: 'claude',
      action: action || 'generate',
      units: inputTokens + outputTokens,
      costUsd,
      tenantId,
      meta: { model, inputTokens, outputTokens },
    },
  }).catch(e => console.error('[CostLogger] Claude:', e.message));
}

// Outscraper: ~$0.001/result on standard plan
export async function logScraper({ records, tenantId = 'default' }) {
  const costUsd = records * 0.001;
  await prisma.apiUsageLog.create({
    data: { service: 'outscraper', action: 'search', units: records, costUsd, tenantId, meta: {} },
  }).catch(e => console.error('[CostLogger] Scraper:', e.message));
}
