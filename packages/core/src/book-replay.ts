import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { pool } from '../../db/src/index.js';
import type { Market, OrderBook } from '../../shared/src/index.js';
import { D, arbitrageQuote, executableDepth, feeFor } from '../../trading/src/math.js';

const DEPTH_LEVEL_LIMIT = 100;
const MAX_PAIR_GAP_MS = 120_000;
const RETENTION_DAYS = 30;
const nonnegative = z.string().regex(/^\d+(\.\d{1,8})?$/).refine(value => D(value).lte(1_000_000));
export const BookReplayInputSchema = z.object({ lookbackHours: z.number().int().min(1).max(720), maxShares: nonnegative.refine(value => D(value).gt(0)).default('10'), latencyMs: z.number().int().min(0).max(MAX_PAIR_GAP_MS), slippageBps: z.number().int().min(0).max(1000), mergeCost: nonnegative, limit: z.number().int().min(1).max(500).default(200) }).strict();
export type BookReplayInput = z.infer<typeof BookReplayInputSchema>;
export interface HistoricalBookPair { id: string; market: Market; yes: OrderBook; no: OrderBook; observedAt: string; depthTruncated: boolean }
export interface BookReplayObservation { snapshotId: string; marketId: string; question: string; observedAt: string; executionAt: string | null; status: 'noop' | 'paired' | 'one-sided' | 'stale-missing'; reason: string; shares: string; yesFilled: boolean; noFilled: boolean; spent: string; net: string | null; unmatchedUnvalued: boolean; depthTruncated: boolean }
export interface BookReplayResult { candidateId: string; createdAt: string; input: BookReplayInput; snapshots: number; truncated: boolean; counts: Record<BookReplayObservation['status'], number>; pairedNet: string; unmatchedUnvalued: boolean; observations: BookReplayObservation[]; limitations: string[] }

function validBook(book: OrderBook, token: string, at: number): boolean {
  const timestamp = Date.parse(book.observedAt);
  try {
    return book.tokenId === token && Number.isFinite(timestamp) && timestamp <= at + 1000 && at - timestamp <= MAX_PAIR_GAP_MS && D(book.minOrderSize).isFinite() && D(book.minOrderSize).gt(0) && D(book.tickSize).isFinite() && D(book.tickSize).gt(0) && [...book.bids, ...book.asks].every(level => D(level.price).isFinite() && D(level.price).gt(0) && D(level.price).lt(1) && D(level.size).isFinite() && D(level.size).gt(0));
  } catch { return false; }
}
function usable(pair: HistoricalBookPair): boolean {
  const at = Date.parse(pair.observedAt), market = pair.market;
  try {
    return Number.isFinite(at) && market.active && !market.closed && !market.resolved && market.acceptingOrders && !market.negRisk && Date.parse(market.endDate) > at && !!market.fee && D(market.fee.rate).isFinite() && D(market.fee.rate).gte(0) && Number.isInteger(market.fee.exponent) && market.fee.exponent >= 0 && validBook(pair.yes, market.yesToken, at) && validBook(pair.no, market.noToken, at);
  } catch { return false; }
}
/** Captures observed depth only; sorting preserves best prices before truncation. */
export async function recordBookSnapshot(market: Market, yes: OrderBook, no: OrderBook): Promise<void> {
  const now = Date.now();
  if (!validBook(yes, market.yesToken, now) || !validBook(no, market.noToken, now)) return;
  const bounded = (book: OrderBook): OrderBook => ({ ...book, bids: [...book.bids].sort((a, b) => D(b.price).cmp(a.price)).slice(0, DEPTH_LEVEL_LIMIT), asks: [...book.asks].sort((a, b) => D(a.price).cmp(b.price)).slice(0, DEPTH_LEVEL_LIMIT) });
  const truncated = [yes.bids, yes.asks, no.bids, no.asks].some(levels => levels.length > DEPTH_LEVEL_LIMIT);
  await pool.query('INSERT INTO book_snapshots(market_id,market_payload,yes_book,no_book,depth_truncated) VALUES($1,$2,$3,$4,$5)', [market.id, JSON.stringify(market), JSON.stringify(bounded(yes)), JSON.stringify(bounded(no)), truncated]);
}
/** Call periodically; bounded deletion avoids a large retention transaction. */
export async function pruneBookSnapshots(): Promise<number> {
  const deleted = await pool.query("DELETE FROM book_snapshots WHERE id IN (SELECT id FROM book_snapshots WHERE observed_at<now()-($1::integer*interval '1 day') ORDER BY observed_at LIMIT 5000)", [RETENTION_DAYS]);
  return deleted.rowCount ?? 0;
}
function leg(book: OrderBook, market: Market, shares: string, limit: string) {
  const fill = executableDepth(book.asks, shares, limit, 'BUY');
  if (!fill.complete) return { complete: false, cost: D(0), fee: D(0) };
  let remaining = D(shares), fee = D(0);
  for (const level of [...book.asks].sort((a, b) => D(a.price).cmp(b.price))) {
    if (D(level.price).gt(limit)) break;
    const size = Decimal.min(remaining, level.size);
    fee = fee.plus(feeFor(market, level.price, size.toFixed())); remaining = remaining.minus(size);
    if (remaining.eq(0)) break;
  }
  return { complete: true, cost: D(fill.cost), fee };
}
/** Pure depth replay: FOK on each leg separately; missing legs never create fake profit. */
export function replayBookPair(decision: HistoricalBookPair, execution: HistoricalBookPair | null, input: BookReplayInput): BookReplayObservation {
  const base: BookReplayObservation = { snapshotId: decision.id, marketId: decision.market.id, question: decision.market.question, observedAt: decision.observedAt, executionAt: execution?.observedAt ?? null, status: 'stale-missing', reason: 'Snapshot tidak valid atau biaya belum terverifikasi', shares: '0', yesFilled: false, noFilled: false, spent: '0', net: null, unmatchedUnvalued: false, depthTruncated: decision.depthTruncated || !!execution?.depthTruncated };
  if (!usable(decision)) return base;
  let quote;
  try { quote = arbitrageQuote(decision.market, decision.yes, decision.no, input.maxShares, input.mergeCost, input.slippageBps); } catch { return base; }
  if (!quote || D(quote.netProfit).lte(0)) return { ...base, status: 'noop', reason: 'Depth tidak cukup atau edge setelah biaya tidak positif' };
  base.shares = quote.shares;
  const elapsed = execution ? Date.parse(execution.observedAt) - Date.parse(decision.observedAt) : NaN;
  if (!execution || execution.market.id !== decision.market.id || execution.market.rulesHash !== decision.market.rulesHash || execution.market.conditionId !== decision.market.conditionId || execution.market.yesToken !== decision.market.yesToken || execution.market.noToken !== decision.market.noToken || elapsed < input.latencyMs || elapsed <= 0 || elapsed > MAX_PAIR_GAP_MS || !usable(execution)) return { ...base, reason: 'Snapshot berikutnya hilang, stale, atau aturan/token berubah' };
  try {
    const yes = leg(execution.yes, execution.market, quote.shares, quote.yesLimit), no = leg(execution.no, execution.market, quote.shares, quote.noLimit);
    const spent = yes.cost.plus(no.cost).mul(D(1).plus(D(input.slippageBps).div(10000))).plus(yes.fee).plus(no.fee);
    if (yes.complete && no.complete) return { ...base, status: 'paired', reason: 'Dua leg FOK memenuhi limit awal pada snapshot tertunda', yesFilled: true, noFilled: true, spent: spent.plus(input.mergeCost).toFixed(8), net: D(quote.shares).minus(spent).minus(input.mergeCost).toFixed(8) };
    if (yes.complete || no.complete) return { ...base, status: 'one-sided', reason: 'Satu leg FOK gagal; posisi terbuka belum dinilai', yesFilled: yes.complete, noFilled: no.complete, spent: spent.toFixed(8), unmatchedUnvalued: true };
    return { ...base, status: 'noop', reason: 'Kedua leg FOK gagal pada limit awal' };
  } catch { return { ...base, reason: 'Perhitungan biaya eksekusi tidak tersedia' }; }
}
export async function bookSnapshotSummary() {
  return (await pool.query("SELECT count(*)::int snapshots,count(DISTINCT market_id)::int markets,min(observed_at) oldest,max(observed_at) newest FROM book_snapshots WHERE observed_at>=now()-interval '30 days'")).rows[0];
}
export async function replayArbitrage(raw: BookReplayInput): Promise<BookReplayResult> {
  const input = BookReplayInputSchema.parse(raw);
  const rows = (await pool.query(`WITH selected AS (SELECT * FROM book_snapshots WHERE observed_at>=now()-($1::integer*interval '1 hour') ORDER BY observed_at DESC,id DESC LIMIT $2)
    SELECT row_to_json(s) decision,row_to_json(e) execution FROM selected s LEFT JOIN LATERAL
    (SELECT * FROM book_snapshots n WHERE n.market_id=s.market_id AND n.observed_at>s.observed_at AND n.observed_at>=s.observed_at+($3::integer*interval '1 millisecond') AND n.observed_at<=s.observed_at+interval '2 minutes' ORDER BY n.observed_at,n.id LIMIT 1) e ON true ORDER BY s.observed_at,s.id`, [input.lookbackHours, input.limit + 1, input.latencyMs])).rows;
  const pair = (row: Record<string, unknown>): HistoricalBookPair => ({ id: row.id as string, market: row.market_payload as Market, yes: row.yes_book as OrderBook, no: row.no_book as OrderBook, observedAt: row.observed_at as string, depthTruncated: row.depth_truncated as boolean });
  const observations = rows.slice(-input.limit).map(row => replayBookPair(pair(row.decision), row.execution ? pair(row.execution) : null, input));
  const counts: BookReplayResult['counts'] = { noop: 0, paired: 0, 'one-sided': 0, 'stale-missing': 0 };
  for (const observation of observations) counts[observation.status]++;
  const result: BookReplayResult = { candidateId: `book-candidate-${randomUUID()}`, createdAt: new Date().toISOString(), input, snapshots: observations.length, truncated: rows.length > input.limit, counts, pairedNet: observations.reduce((sum, item) => sum.plus(item.net ?? 0), D(0)).toFixed(8), unmatchedUnvalued: observations.some(item => item.unmatchedUnvalued), observations, limitations: ['Depth maksimal 100 level per sisi; hasil hanya berdasarkan likuiditas yang teramati.', 'Snapshot paling awal setelah latency, maksimal jarak 2 menit; perubahan di antara snapshot tidak diketahui.', 'FOK masing-masing leg bukan atomic pair; one-sided tetap belum dinilai dan tidak masuk paired net.', 'Slippage surcharge diterapkan konservatif selain harga depth, fee terverifikasi dan asumsi merge cost.', 'Simulasi berulang per snapshot independen; tidak memodelkan penggunaan modal, antrian, kompetisi, dampak order atau keberhasilan on-chain merge.', 'Kandidat terisolasi: tidak memposting ledger, mengubah policy, atau memberi kelayakan live.'] };
  await pool.query("INSERT INTO checkpoints(id,stage,result) VALUES($1,'book-replay-candidate',$2)", [result.candidateId, JSON.stringify(result)]);
  return result;
}
