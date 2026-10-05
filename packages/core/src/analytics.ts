import { pool } from '../../db/src/index.js';
import { readControl } from './state.js';

export async function tradingAnalytics(days: number) {
  const {mode}=await readControl(), since=new Date(Date.now()-days*86400000).toISOString();
  const [strategies,daily,execution,exposure,calibration,costs]=await Promise.all([
    pool.query(`WITH cycles AS (
      SELECT strategy,market_id,max(closed_at) closed_at,sum(realized_pnl-fees) net,
        bool_and(status='closed' AND shares=0 AND closed_at IS NOT NULL) closed
      FROM positions WHERE mode=$1 GROUP BY strategy,market_id
    ) SELECT strategy,count(*) FILTER(WHERE closed AND closed_at>=$2)::int closed,
      count(*) FILTER(WHERE closed AND closed_at>=$2 AND net>0)::int wins,
      count(*) FILTER(WHERE closed AND closed_at>=$2 AND net<0)::int losses,
      coalesce(sum(net) FILTER(WHERE closed AND closed_at>=$2),0)::text pnl,
      avg(net) FILTER(WHERE closed AND closed_at>=$2)::text expectancy,
      (coalesce(sum(net) FILTER(WHERE closed AND closed_at>=$2 AND net>0),0)/nullif(abs(sum(net) FILTER(WHERE closed AND closed_at>=$2 AND net<0)),0))::text profit_factor
      FROM cycles GROUP BY strategy`,[mode,since]),
    pool.query(`WITH closes AS (SELECT DISTINCT ON((at AT TIME ZONE 'UTC')::date) (at AT TIME ZONE 'UTC')::date AS trading_day,pnl,value,drawdown
      FROM equity WHERE mode=$1 AND at>=$2::timestamptz-interval '1 day' ORDER BY (at AT TIME ZONE 'UTC')::date,at DESC),
      changes AS (SELECT *,pnl-lag(pnl) OVER(ORDER BY trading_day) daily_pnl FROM closes)
      SELECT trading_day::text AS day, daily_pnl::text,pnl::text,value::text equity,drawdown::text FROM changes WHERE trading_day>=($2::timestamptz AT TIME ZONE 'UTC')::date ORDER BY trading_day`,[mode,since]),
    pool.query(`SELECT count(*)::int orders,count(*) FILTER(WHERE status='filled')::int filled,
      count(*) FILTER(WHERE status='rejected')::int rejected,count(*) FILTER(WHERE status IN('ambiguous','settling','recovery','submitting'))::int unresolved,
      (SELECT coalesce(sum(notional),0)::text FROM fills WHERE mode=$1 AND created_at>=$2 AND status='confirmed') notional,
      (SELECT coalesce(sum(fee),0)::text FROM fills WHERE mode=$1 AND created_at>=$2 AND status='confirmed') fees
      FROM orders WHERE mode=$1 AND created_at>=$2`,[mode,since]),
    pool.query(`SELECT p.event_id,p.strategy,count(*)::int legs,sum(p.cost_basis)::text cost,
      CASE WHEN bool_and(p.mark IS NOT NULL AND p.marked_at>now()-interval '120 seconds') THEN sum(p.shares*p.mark) END::text value,
      max(m.payload->>'question') question FROM positions p JOIN markets m ON m.id=p.market_id WHERE p.mode=$1 AND p.shares>0
      GROUP BY p.event_id,p.strategy ORDER BY sum(p.cost_basis) DESC LIMIT 30`,[mode]),
    pool.query(`WITH first_forecasts AS (SELECT DISTINCT ON(f.market_id) f.* FROM forecasts f JOIN markets m ON m.id=f.market_id
      WHERE f.outcome IN(0,1) AND f.resolved_at IS NOT NULL AND f.created_at>= $1 AND f.created_at<f.resolved_at AND f.created_at<(m.payload->>'endDate')::timestamptz
      ORDER BY f.market_id,f.created_at)
      SELECT least(9,floor((payload->>'probability')::numeric*10))::int bucket,count(*)::int events,
      avg((payload->>'probability')::numeric)::float8 prediction,avg(outcome)::float8 observed,
      avg(power((payload->>'probability')::numeric-outcome,2))::float8 brier,
      avg(power(baseline-outcome,2))::float8 baseline_brier FROM first_forecasts GROUP BY bucket ORDER BY bucket`,[since]),
    pool.query(`SELECT coalesce(sum(e.amount),0)::text total FROM ledger_entries e JOIN journals j ON j.id=e.journal_id WHERE e.mode=$1 AND e.account='operating-cost' AND j.created_at>=$2`,[mode,since])
  ]);
  return {mode,since,days,at:new Date().toISOString(),strategies:strategies.rows,daily:daily.rows,execution:execution.rows[0],exposure:exposure.rows,calibration:calibration.rows,operatingCosts:costs.rows[0].total};
}
