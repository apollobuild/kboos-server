import { PgBoss } from 'pg-boss';

let boss = null;

export async function startQueue() {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    deleteAfterDays: 7,
    archiveCompletedAfterSeconds: 3600,
  });
  boss.on('error', err => console.error('[Queue] pg-boss error:', err.message));
  await boss.start();
  console.log('[Queue] pg-boss started');
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
  const queues = ['lead-qualify','lead-enrichment','lead-ai-score','ai-asset-gen','lead-personalize','lead-scrape','outreach-email','outreach-wa','outreach-voice','channel-eligibility','optimization-loop'];
  const stats = {};
  for (const name of queues) {
    try {
      const qs = await q.getQueueStats(name);
      stats[name] = qs?.size ?? 0;
    } catch { stats[name] = 0; }
  }
  return stats;
}
