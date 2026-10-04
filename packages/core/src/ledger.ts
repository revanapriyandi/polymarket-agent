import Decimal from 'decimal.js';
import { pool, transaction, type Transaction } from '../../db/src/index.js';
import type { Mode, Metrics, Settings } from '../../shared/src/index.js';
export const d = (v: Decimal.Value) => new Decimal(v);
Decimal.set({ precision: 38, rounding: Decimal.ROUND_HALF_EVEN });
type Posting = { account: string; amount: string };
export async function postJournal(client: Transaction, id: string, mode: Mode, kind: string, description: string, postings: Posting[], metadata: Record<string, unknown> = {}): Promise<boolean> {
  postings = postings.map(p=>({...p,amount:d(p.amount).toDecimalPlaces(12).toFixed()}));
  if (postings.some(p => !d(p.amount).isFinite()) || !postings.reduce((sum, p) => sum.plus(p.amount), d(0)).eq(0)) throw new Error('Unbalanced journal rejected');
  const inserted = await client.query('INSERT INTO journals(id,mode,kind,description,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id', [id, mode, kind, description, JSON.stringify(metadata)]);
  if (!inserted.rowCount) return false;
  for (const p of postings) await client.query('INSERT INTO ledger_entries(journal_id,mode,account,amount) VALUES($1,$2,$3,$4)', [id, mode, p.account, p.amount]);
  return true;
}
export async function chargeService(id: string, mode: Mode, costUsd: string, conversion: string, description: string) {
  const amount = d(costUsd).mul(conversion).toDecimalPlaces(12);
  await transaction(client => postJournal(client, `service:${id}`, mode, 'operating-cost', description, [{ account: 'operating-cost', amount: amount.toFixed() }, { account: 'operating-payable', amount: amount.negated().toFixed() }], { costUsd, conversion, denomination: 'USD', valuation: 'estimated-pUSD' }));
}
export async function metrics(mode: Mode, settings: Settings, client?: Transaction): Promise<Metrics> {
  const q = client ?? pool;
  const ledger = await q.query<{ account: string; amount: string }>('SELECT account,sum(amount)::text amount FROM ledger_entries WHERE mode=$1 GROUP BY account', [mode]);
  const balances = Object.fromEntries(ledger.rows.map(r => [r.account, d(r.amount)]));
  const cash = balances.cash ?? d(0), capital = (balances.capital ?? d(0)).negated(), cost = balances['operating-cost'] ?? d(0), fees = balances.fees ?? d(0);
  const reserved = await q.query<{ total: string }>("SELECT coalesce(sum(reserved),0)::text total FROM orders WHERE mode=$1", [mode]);
  const pos = await q.query<{ shares: string; cost_basis: string; mark: string | null; marked_at: Date | null; status: string }>("SELECT shares,cost_basis,mark,marked_at,status FROM positions WHERE mode=$1 AND shares>0", [mode]);
  const unresolved = pos.rows.filter(p => p.mark === null || !p.marked_at || Date.now() - p.marked_at.getTime() > 120_000);
  const positionValue = unresolved.length ? null : pos.rows.reduce((s, p) => s.plus(d(p.shares).mul(p.mark!)), d(0));
  const basis = pos.rows.reduce((s, p) => s.plus(p.cost_basis), d(0));
  const pending = await q.query<{ total: string; count: number }>("SELECT coalesce(sum(coalesce(f.notional,f.shares*f.price)+coalesce(f.fee,0)),0)::text total,count(*)::int count FROM fills f WHERE mode=$1 AND status NOT IN ('confirmed','failed','reconciled')", [mode]);
  const pendingCost = d(pending.rows[0].total);
  const equity = positionValue === null || pending.rows[0].count>0 ? null : cash.plus(positionValue).minus(cost);
  const pnl = equity?.minus(capital) ?? null;
  const max = await q.query<{ max: string | null }>('SELECT max(pnl)::text max FROM equity WHERE mode=$1', [mode]);
  const peak = capital.plus(Decimal.max(0, max.rows[0].max ?? 0, pnl ?? 0));
  const drawdown = equity && peak.gt(0) ? Decimal.max(0, peak.minus(equity).div(peak)) : d(0);
  const start = await q.query<{ pnl: string }>("SELECT pnl::text FROM equity WHERE mode=$1 AND at<date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' ORDER BY at DESC LIMIT 1", [mode]);
  const realized = (balances['realized-pnl'] ?? d(0)).negated();
  return { cash: cash.toFixed(), reserved: reserved.rows[0].total, available: cash.minus(reserved.rows[0].total).toFixed(), positionValue: positionValue?.toFixed() ?? null, pendingSettlement: pendingCost.toFixed(), equity: equity?.toFixed() ?? null, realizedPnl: realized.minus(fees).toFixed(), unrealizedPnl: positionValue?.minus(basis).toFixed() ?? null, totalPnl: pnl?.toFixed() ?? null, tradingFees: fees.toFixed(), operatingCosts: cost.toFixed(), exposure: capital.gt(0) ? basis.plus(reserved.rows[0].total).div(capital).toFixed() : '0', drawdown: drawdown.toFixed(), dailyPnl: pnl?.minus(start.rows[0]?.pnl ?? 0).toFixed() ?? '0', capital: capital.toFixed(), unmarkedPositions: unresolved.length };
}
export async function settleFill(input: { id: string; orderId: string; shares: string; price: string; fee: string; notional?: string }) {
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73011)');
    const order = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [input.orderId])).rows[0];
    if (!order) throw new Error('Unknown order for settlement');
    const fill = await client.query('SELECT * FROM fills WHERE id=$1 FOR UPDATE', [input.id]);
    if (fill.rows[0] && fill.rows[0].order_id !== input.orderId) throw new Error('Fill identity belongs to another order');
    if (fill.rows[0]?.status === 'confirmed') {
      const previous = fill.rows[0];
      if (!d(previous.shares).eq(input.shares) || !d(previous.price).eq(input.price) || !d(previous.fee).eq(input.fee) || !d(previous.notional ?? d(previous.shares).mul(previous.price)).eq(input.notional ?? d(input.shares).mul(input.price))) throw new Error('Confirmed fill identity cannot change');
      return;
    }
    const mode = order.mode as Mode, intent = order.intent, qty = d(input.shares), value = d(input.notional ?? qty.mul(input.price)).toDecimalPlaces(12), fee = d(input.fee).toDecimalPlaces(12);
    if (![qty,value,fee,d(input.price)].every(v=>v.isFinite()) || qty.lte(0) || fee.lt(0) || d(input.price).lte(0) || d(input.price).gte(1)) throw new Error('Invalid fill values');
    if (intent.side === 'BUY' ? d(input.price).gt(intent.limitPrice) : d(input.price).lt(intent.limitPrice)) throw new Error('Fill breaches authorized limit');
    if (intent.side === 'BUY' && value.plus(fee).gt(order.reserved)) throw new Error('Fill exceeds remaining reserved collateral');
    if (d(order.filled_shares).plus(qty).gt(intent.shares)) throw new Error('Fill exceeds authorized order size');
    if(value.lte(0)||value.gt(qty)) throw new Error('Invalid collateral notional');
    const existingJournal=await client.query('SELECT id FROM journals WHERE id=$1',[`fill:${input.id}`]);
    if(existingJournal.rowCount) throw new Error('Journal/fill state inconsistent; reconcile before applying again');
    await client.query("INSERT INTO positions(mode,market_id,event_id,token_id,strategy,profile_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (mode,token_id,strategy) DO NOTHING", [mode, order.market_id, order.event_id, order.token_id, order.strategy === 'exit' ? intent.recoveryFor ?? 'prediction' : order.strategy, order.profile_version]);
    const position = (await client.query('SELECT * FROM positions WHERE mode=$1 AND token_id=$2 AND strategy=$3 FOR UPDATE', [mode, order.token_id, order.strategy === 'exit' ? intent.recoveryFor ?? 'prediction' : order.strategy])).rows[0];
    if (intent.side === 'BUY') {
      await postJournal(client, `fill:${input.id}`, mode, 'fill', 'Pembelian saham terkonfirmasi', [{ account: 'cash', amount: value.plus(fee).negated().toFixed() }, { account: 'position', amount: value.toFixed() }, { account: 'fees', amount: fee.toFixed() }], { orderId: input.orderId });
      await client.query("UPDATE positions SET shares=shares+$1,cost_basis=cost_basis+$2,fees=fees+$3,mark=$4,marked_at=now(),updated_at=now(),status='open',closed_at=NULL WHERE id=$5", [qty.toFixed(), value.toFixed(), fee.toFixed(), input.price, position.id]);
    } else {
      if (d(position.shares).lt(qty)) throw new Error('Settlement would oversell position');
      const removedBasis = d(position.cost_basis).mul(qty).div(position.shares).toDecimalPlaces(12), profit = value.minus(removedBasis);
      await postJournal(client, `fill:${input.id}`, mode, 'fill', 'Penjualan saham terkonfirmasi', [{ account: 'cash', amount: value.minus(fee).toFixed() }, { account: 'position', amount: removedBasis.negated().toFixed() }, { account: 'realized-pnl', amount: profit.negated().toFixed() }, { account: 'fees', amount: fee.toFixed() }], { orderId: input.orderId });
      await client.query("UPDATE positions SET shares=shares-$1,reserved_shares=greatest(0,reserved_shares-$1),cost_basis=cost_basis-$2,realized_pnl=realized_pnl+$3,fees=fees+$4,status=CASE WHEN shares=$1 THEN 'closed' ELSE 'open' END,closed_at=CASE WHEN shares=$1 THEN now() ELSE NULL END,updated_at=now() WHERE id=$5", [qty.toFixed(), removedBasis.toFixed(), profit.toFixed(), fee.toFixed(), position.id]);
    }
    await client.query("INSERT INTO fills(id,order_id,mode,status,shares,price,fee,notional,settled_at) VALUES($1,$2,$3,'confirmed',$4,$5,$6,$7,now()) ON CONFLICT(id) DO UPDATE SET status='confirmed',shares=excluded.shares,price=excluded.price,fee=excluded.fee,notional=excluded.notional,settled_at=now()", [input.id, input.orderId, mode, qty.toFixed(), input.price, fee.toFixed(),value.toFixed()]);
    const complete = d(order.filled_shares).plus(qty).gte(intent.shares);
    await client.query("UPDATE orders SET filled_shares=filled_shares+$1,reserved=CASE WHEN $2 THEN 0 ELSE greatest(0,reserved-$3) END,status=CASE WHEN $2 THEN 'filled' ELSE 'partial' END,updated_at=now() WHERE id=$4", [qty.toFixed(), complete, value.plus(fee).toFixed(), input.orderId]);
  });
}
export async function releaseOrder(id: string, status: 'cancelled' | 'rejected' | 'expired', message: string) {
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73011)');
    const { rows } = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    const row = rows[0]; if (!row || ['filled', 'cancelled', 'rejected', 'expired'].includes(row.status)) return;
    const intent = row.intent;
    if (intent.side === 'SELL') await client.query('UPDATE positions SET reserved_shares=greatest(0,reserved_shares-$1) WHERE mode=$2 AND token_id=$3 AND strategy=$4', [d(intent.shares).minus(row.filled_shares).toFixed(), row.mode, row.token_id, intent.recoveryFor ?? 'prediction']);
    await client.query('UPDATE orders SET status=$1,reserved=0,message=$2,updated_at=now() WHERE id=$3', [status, message, id]);
  });
}
