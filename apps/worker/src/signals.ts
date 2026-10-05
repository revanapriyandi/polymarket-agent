import { pool } from '../../../packages/db/src/index.js';
import { redis } from '../../../packages/core/src/queue.js';
import { readControl, writeState } from '../../../packages/core/src/state.js';
import { entryFeedGuard } from '../../../packages/core/src/market-stream.js';
import { ENTRY_BOOK_MAX_AGE_MS, QUOTE_MAX_AGE_MS, type SignalTiming } from '../../../packages/shared/src/realtime.js';
import type { Runtime } from './context.js';
import { task } from './pipeline.js';
import { considerMarket } from './strategies.js';

export async function considerSignal(marketId: string, jobId: string, runtime: Runtime, receivedAt?: number) {
  const start = Date.now(), timing: SignalTiming = { marketId, at: new Date().toISOString(), queueMs: receivedAt ? start - receivedAt : 0, quoteAgeMs: 0, validationMs: 0, totalMs: 0, considered: false, reason: 'Menunggu validasi' };
  const lease = await pool.connect(); let acquired = false;
  try {
    if (receivedAt && (start - receivedAt > QUOTE_MAX_AGE_MS || receivedAt > start + 1000)) { timing.reason = 'Sinyal terlambat di antrean; menunggu pembaruan berikutnya'; return timing; }
    acquired = (await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,73051)) acquired', [marketId])).rows[0].acquired;
    if (!acquired) { timing.reason = 'Pasar sedang diproses; operasi duplikat dilewati'; return timing; }
    if ((await readControl()).state !== 'running') { timing.reason = 'Entry dijeda'; return timing; }
    const market = await runtime.public.getMarket(marketId);
    const guard = await entryFeedGuard([market.yesToken, market.noToken]);
    if (!guard.ready) { timing.reason = guard.reason; return timing; }
    const [yes, no] = await Promise.all([runtime.public.getBook(market.yesToken), runtime.public.getBook(market.noToken)]);
    timing.validationMs = Date.now() - start;
    timing.quoteAgeMs = Math.max(Date.now() - Date.parse(yes.observedAt), Date.now() - Date.parse(no.observedAt));
    if (!Number.isFinite(timing.quoteAgeMs) || timing.quoteAgeMs > ENTRY_BOOK_MAX_AGE_MS || timing.quoteAgeMs < -1000) { timing.reason = 'Order book REST melebihi batas entry 1 detik'; return timing; }
    const result = await task('strategy', 'propose', jobId, { marketId }, () => considerMarket(market, yes, no, runtime));
    timing.considered = result?.considered ?? false; timing.reason = result && 'reason' in result ? result.reason ?? 'Selesai' : result ? 'Pemeriksaan peluang selesai' : 'Tool strategi gagal';
    return timing;
  } finally {
    if (acquired) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,73051))', [marketId]);
    lease.release(); timing.totalMs = Date.now() - start;
    if (receivedAt) {
      await writeState('signal-timing', timing);
      await redis.pipeline().lpush('polymarket:signal-timings', JSON.stringify(timing)).ltrim('polymarket:signal-timings', 0, 199).expire('polymarket:signal-timings', 86400).exec();
    }
  }
}
