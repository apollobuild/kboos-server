import { PgBoss } from 'pg-boss';

let boss = null;

const QUEUE_NAMES = [
  'lead-qualify',
  'lead-enrichment',
  'lead-ai-score',
  'ai-asset-gen',
  'lead-personalize',
  'lead-scrape',
  'outreach-email',
  'outreach-wa',
  'outreach-voice',
  'channel-eligibility',
  'optimization-loop',
  'lead-validation',
  'auto-reply',
  'meeting-notify',
  'weekly-report',
];

export async function startQueue() {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    deleteAfterDays: 7,
    archiveCompletedAfterSeconds: 3600,
  });
  boss.on('error', err => console.error('[Queue] pg-boss error:', err.message));
  await boss.start();

  // pg-boss v12 requires explicit queue creation before send/work
  for (const name of QUEUE_NAMES) {
    try {
      await boss.createQueue(name);
    } catch (e) {
      // Queue already exists — safe to ignore
      if (!e.message?.includes('already exists')) {
        console.warn(`[Queue] createQueue(${name}):`, e.message);
      }
    }
  }

  console.log('[Queue] pg-boss started, all queues ready');
  return boss;
}

export function getQueue() {
  if (!boss) throw new Error('[Queue] pg-boss not started');
  return boss;
}

const DEFAULT_OPTS = { retryLimit: 3, retryBackoff: true, retryDelay: 30, expireInHours: 24 };

export async function enqueue(queueName, data, opts = {}) {
  return getQueue().send(queueName, data, { ...DEFAULT_OPTS, ...opts });
}

export async function enqueueBatch(queueName, items, opts = {}) {
  const jobs = items.map(data => ({ name: queueName, data, ...DEFAULT_OPTS, ...opts }));
  return getQueue().insert(jobs);
}

export async function registerWorker(queueName, concurrency, handler) {
  return getQueue().work(queueName, { teamSize: concurrency, teamConcurrency: concurrency }, handler);
}

export async function getQueueStats() {
  const q = getQueue();
  const stats = {};
  for (const name of QUEUE_NAMES) {
    try {
      const qs = await q.getQueueStats(name);
      stats[name] = qs?.size ?? 0;
    } catch { stats[name] = 0; }
  }
  return stats;
}
