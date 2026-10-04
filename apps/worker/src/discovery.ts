import { Worker } from 'bullmq';
import { discoveryQueue, queueConnection } from '../../../packages/core/src/queue.js';
import { pool } from '../../../packages/db/src/index.js';
import type { Market } from '../../../packages/shared/src/index.js';
import type { Runtime } from './context.js';
import { scan, task, resolveForecasts } from './pipeline.js';
import { trendRefresh } from './trends.js';

/** Discovery never authorizes or submits orders; scan enqueues operation work. */
export function startDiscovery(runtime: Runtime, onMarkets: (markets: Market[]) => Promise<void>): Worker {
  return new Worker('polymarket-discovery', async job => {
    const jobId = String(job.id);
    if (job.name === 'resolve-forecasts') return resolveForecasts(runtime);
    if (job.name === 'scan') {
      const markets = await scan(runtime, jobId);
      if (markets) await onMarkets(markets);
      else {
        const rows = (await pool.query('SELECT payload FROM markets ORDER BY updated_at DESC LIMIT 200')).rows;
        await onMarkets(rows.map(row => row.payload as Market));
      }
      return;
    }
    if (job.name === 'trends' || job.name === 'refresh-trends') return task('research', 'trends', jobId, {}, () => trendRefresh());
    throw new Error('Unknown discovery job');
  }, { connection: queueConnection, concurrency: 1, lockDuration: 300000, maxStalledCount: 0 });
}

export async function initializeDiscoverySchedule(): Promise<void> {
  await discoveryQueue.upsertJobScheduler('discovery-scan', { every: 5000 }, { name: 'scan', data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } });
  await discoveryQueue.upsertJobScheduler('discovery-trends', { every: 300000 }, { name: 'trends', data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } });
  await discoveryQueue.upsertJobScheduler('discovery-resolutions', { every: 60000 }, { name: 'resolve-forecasts', data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } });
}
