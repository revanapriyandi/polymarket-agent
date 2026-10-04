import { pool } from '../../db/src/index.js';
import type { Settings, EvaluationView } from '../../shared/src/index.js';
import { profileVersion, selectedForecastProfiles, type SelectedForecastModel } from './profiles.js';
import { d } from './ledger.js';
/** Exact model profile gates. Shared costs use declared strategy allocation; unattributed overlapping profile costs remain conservative. */
export async function evaluateProfile(strategy: 'arbitrage' | 'prediction', settings: Settings, selected?: SelectedForecastModel): Promise<EvaluationView> {
    const version = await profileVersion(strategy, settings, selected);
    const summary = (await pool.query("SELECT min(opened_at) first_at,count(*) FILTER(WHERE status='closed' AND shares=0 AND closed_at IS NOT NULL)::int closed_trades,coalesce(sum(realized_pnl-fees),0)::text profit FROM positions WHERE mode='paper' AND strategy=$1 AND profile_version=$2", [strategy, version])).rows[0];
    const models = selected ? [selected] : await selectedForecastProfiles();
    const actual = selected ?? models[0];
    const scoring = (await pool.query("SELECT count(DISTINCT market_id)::int events,avg(power((payload->>'probability')::numeric-outcome,2))::float8 brier,avg(power(baseline-outcome,2))::float8 baseline FROM (SELECT DISTINCT ON (f.market_id) f.* FROM forecasts f JOIN markets m ON m.id=f.market_id WHERE profile_version=$1 AND outcome IN (0,1) AND resolved_at IS NOT NULL AND f.created_at<f.resolved_at AND f.created_at<(m.payload->>'endDate')::timestamptz AND f.rules_hash=m.rules_hash AND baseline BETWEEN 0 AND 1 AND ($2::uuid IS NULL OR provider_id=$2 AND provider_version=$3) ORDER BY f.market_id,f.created_at) f", [version, actual?.providerId ?? null, actual?.providerVersion ?? null])).rows[0];
    if (strategy === 'arbitrage') {
      // Two complementary legs are one completed market cycle, never two independent successful trades.
      summary.closed_trades = (await pool.query("SELECT count(*)::int count FROM (SELECT market_id FROM positions WHERE mode='paper' AND strategy='arbitrage' AND profile_version=$1 GROUP BY market_id HAVING count(DISTINCT token_id)=2 AND bool_and(status='closed' AND shares=0 AND closed_at IS NOT NULL)) cycles", [version])).rows[0].count;
    }
    const pending = (await pool.query("SELECT count(*)::int count FROM orders WHERE mode='paper' AND status IN ('ambiguous','submitting','settling','recovery')")).rows[0].count;
    const settlementPending = (await pool.query("SELECT count(*)::int count FROM settlements WHERE mode='paper' AND status NOT IN ('confirmed','failed')")).rows[0].count;
    const fillsPending = (await pool.query("SELECT count(*)::int count FROM fills WHERE mode='paper' AND status NOT IN ('confirmed','failed','reconciled')")).rows[0].count;
    const unmarked = (await pool.query("SELECT count(*)::int count FROM positions WHERE mode='paper' AND shares>0 AND (mark IS NULL OR marked_at IS NULL OR marked_at<now()-interval '2 minutes' OR status NOT IN ('open','closed'))")).rows[0].count;
    const ledgerInvalid = (await pool.query("SELECT count(*)::int count FROM (SELECT j.id FROM journals j LEFT JOIN ledger_entries e ON e.journal_id=j.id WHERE j.mode='paper' GROUP BY j.id HAVING count(e.id)<2 OR coalesce(sum(e.amount),0)<>0) invalid")).rows[0].count;
    const allocationTotal = d(settings.paper.arbitrageAllocation).plus(settings.paper.predictionAllocation);
    const strategyAllocation = allocationTotal.gt(0) ? d(strategy === 'prediction' ? settings.paper.predictionAllocation : settings.paper.arbitrageAllocation).div(allocationTotal).toFixed() : '0';
    const costRows = (await pool.query("SELECT e.amount::text amount,j.id,j.metadata,i.role FROM ledger_entries e JOIN journals j ON j.id=e.journal_id LEFT JOIN invocations i ON j.id='service:'||i.id::text WHERE e.mode='paper' AND e.account='operating-cost' AND j.created_at>=coalesce($1,now())", [summary.first_at])).rows;
    let attributedCost = d(0), attributionUnknown = 0;
    for (const cost of costRows) {
      const metadata = cost.metadata ?? {};
      if (metadata.profileVersion) { if (metadata.profileVersion === version) attributedCost = attributedCost.plus(cost.amount); continue; }
      if (metadata.strategy) { if (metadata.strategy === strategy) attributedCost = attributedCost.plus(cost.amount); continue; }
      if (['forecast', 'research', 'evidence', 'summary'].includes(cost.role)) { if (strategy === 'prediction') attributedCost = attributedCost.plus(cost.amount); continue; }
      if (cost.id.startsWith('service:infrastructure:')) { attributedCost = attributedCost.plus(d(cost.amount).mul(strategyAllocation)); continue; }
      if (cost.role?.startsWith('probe:') || cost.role === 'model-discovery') continue;
      // Unknown service attribution is charged conservatively and blocks eligibility until categorized.
      attributedCost = attributedCost.plus(cost.amount); attributionUnknown++;
    }
    const unknown = (await pool.query("SELECT count(*)::int count FROM invocations WHERE mode='paper' AND created_at>=coalesce($1,now()) AND (cost IS NULL OR status='running') AND role NOT LIKE 'probe:%' AND role<>'model-discovery'", [summary.first_at])).rows[0].count;
    const unposted = (await pool.query("SELECT count(*)::int count FROM invocations i WHERE mode='paper' AND created_at>=coalesce($1,now()) AND role NOT LIKE 'probe:%' AND role<>'model-discovery' AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.id='service:'||i.id::text)", [summary.first_at])).rows[0].count;
    const maximum = (await pool.query("SELECT coalesce(max(drawdown),0)::text value,count(*)::int samples FROM equity WHERE mode='paper' AND at>=coalesce($1,now())", [summary.first_at])).rows[0];
    const days = summary.first_at ? Math.max(0, Math.floor((Date.now() - new Date(summary.first_at).getTime()) / 86400000)) : 0;
    const net = d(summary.profit).minus(attributedCost), unresolved = pending + settlementPending + fillsPending + unmarked + ledgerInvalid;
    const reasons: string[] = [];
    if (days < 30) reasons.push(`Paper ${days}/30 hari`);
    if (summary.closed_trades < 100) reasons.push(`Transaksi selesai ${summary.closed_trades}/100`);
    if (net.lte(0)) reasons.push('Hasil bersih setelah seluruh biaya layanan belum positif');
    if (d(maximum.value).gt(settings.live?.maxDrawdown ?? settings.paper.maxDrawdown)) reasons.push('Drawdown melewati batas');
    if (maximum.samples < 2) reasons.push('Data equity/drawdown belum cukup');
    if (unresolved > 0) reasons.push('Rekonsiliasi, valuasi, settlement atau jurnal belum valid');
    if (unknown > 0 || unposted > 0 || attributionUnknown > 0) reasons.push('Biaya layanan belum diketahui atau belum diposting ke ledger');
    if (strategy === 'prediction') {
      if (scoring.events < 50) reasons.push(`Event terselesaikan ${scoring.events}/50`);
      if (!Number.isFinite(scoring.brier) || !Number.isFinite(scoring.baseline) || scoring.brier >= scoring.baseline) reasons.push('Kalibrasi belum mengungguli probabilitas pasar');
    }
    return { strategy, profileVersion: version, paperDays: days, closedTrades: summary.closed_trades, resolvedEvents: scoring.events, netPnl: net.toFixed(), maxDrawdown: maximum.value, unresolved, brier: scoring.brier, baselineBrier: scoring.baseline, eligible: reasons.length === 0, reasons };
}
export async function evaluate(settings: Settings): Promise<EvaluationView[]> {
  const results = [await evaluateProfile('arbitrage', settings)];
  const models = await selectedForecastProfiles();
  if (!models.length) results.push(await evaluateProfile('prediction', settings));
  for (const model of models) results.push(await evaluateProfile('prediction', settings, model));
  return results;
}
