import { randomUUID } from 'node:crypto';
import { pool } from '../../db/src/index.js';
import { d } from './ledger.js';
export interface ReplayInput { profileVersion: string; minimumEdge: number; lookbackDays: number; limit: number }
export interface ReplayResult {
  candidateId: string; createdAt: string; input: ReplayInput; status: 'insufficient' | 'assessed';
  evidence: { events: number; selected: number; truncated: boolean; forecastIds: string[] };
  brier: number | null; baselineBrier: number | null;
  buckets: { from: number; to: number; events: number; probability: number | null; outcomeRate: number | null }[];
  hypothetical: { unitStake: string; grossReturn: string; averageReturn: string | null; wins: number; losses: number };
  limitations: string[];
}
/** Retrospective signal assessment only. Stored midpoint is not an executable order-book quote. */
export async function replayCandidate(input: ReplayInput): Promise<ReplayResult> {
  const rows = (await pool.query(`SELECT * FROM (SELECT DISTINCT ON (f.market_id) f.id,f.market_id,f.created_at,f.baseline,f.outcome,f.payload
    FROM forecasts f JOIN markets m ON m.id=f.market_id
    WHERE f.profile_version=$1 AND f.outcome IN (0,1) AND f.resolved_at IS NOT NULL
      AND f.created_at<f.resolved_at AND f.created_at<(m.payload->>'endDate')::timestamptz AND f.rules_hash=m.rules_hash
      AND f.created_at>=now()-($2::integer*interval '1 day') AND f.baseline>0 AND f.baseline<1
      AND f.payload->>'abstain'='false' AND (f.payload->>'probability')::numeric BETWEEN 0 AND 1
    ORDER BY f.market_id,f.created_at) prospective ORDER BY created_at DESC LIMIT $3`, [input.profileVersion, input.lookbackDays, input.limit + 1])).rows;
  const samples = rows.slice(0, input.limit);
  const buckets = Array.from({ length: 10 }, (_, index) => ({ from: index / 10, to: (index + 1) / 10, events: 0, sum: 0, outcomes: 0 }));
  let brier = 0, baselineBrier = 0, selected = 0, wins = 0, losses = 0, gross = d(0);
  for (const row of samples) {
    const probability = Number(row.payload.probability), baseline = Number(row.baseline), outcome = Number(row.outcome);
    brier += (probability - outcome) ** 2; baselineBrier += (baseline - outcome) ** 2;
    const bucket = buckets[Math.min(9, Math.floor(probability * 10))];
    bucket.events++; bucket.sum += probability; bucket.outcomes += outcome;
    if (Math.abs(probability - baseline) < input.minimumEdge) continue;
    const yes = probability > baseline, price = d(yes ? row.baseline : d(1).minus(row.baseline)), won = yes ? outcome === 1 : outcome === 0;
    selected++; if (won) wins++; else losses++;
    gross = gross.plus(won ? d(1).div(price).minus(1) : -1);
  }
  const result: ReplayResult = {
    candidateId: `candidate-${randomUUID()}`, createdAt: new Date().toISOString(), input,
    status: samples.length >= 50 && selected >= 50 ? 'assessed' : 'insufficient',
    evidence: { events: samples.length, selected, truncated: rows.length > input.limit, forecastIds: samples.map(row => row.id) },
    brier: samples.length ? brier / samples.length : null, baselineBrier: samples.length ? baselineBrier / samples.length : null,
    buckets: buckets.map(bucket => ({ from: bucket.from, to: bucket.to, events: bucket.events, probability: bucket.events ? bucket.sum / bucket.events : null, outcomeRate: bucket.events ? bucket.outcomes / bucket.events : null })),
    hypothetical: { unitStake: '1', grossReturn: gross.toFixed(8), averageReturn: selected ? gross.div(selected).toFixed(8) : null, wins, losses },
    limitations: ['Retrospektif: pemilihan threshold memakai data yang sama; belum validasi out-of-sample.', 'Midpoint tersimpan bukan harga eksekusi; biaya, spread, depth, slippage, partial fill dan latency tidak dimodelkan.', 'Return hipotetis stake 1 per event bukan P&L paper/live dan tidak mengubah policy atau kelayakan live.', 'Satu forecast pertama per event dan profil; data tanpa outcome biner/cutoff valid/aturan sama dikecualikan.', 'Minimal 50 event dan 50 sinyal diperlukan untuk status assessed; status tersebut bukan persetujuan trading.'],
  };
  await pool.query("INSERT INTO checkpoints(id,stage,result) VALUES($1,'candidate-assessment',$2)", [result.candidateId, JSON.stringify(result)]);
  return result;
}
