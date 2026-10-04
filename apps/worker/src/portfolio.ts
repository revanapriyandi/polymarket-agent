import { pool, transaction } from '../../../packages/db/src/index.js';
import { d, postJournal, metrics, settleFill, releaseOrder } from '../../../packages/core/src/ledger.js';
import { readSettings, readState, audit, writeState } from '../../../packages/core/src/state.js';
import { env } from '../../../packages/core/src/config.js';
import { executableDepth, feeFor } from '../../../packages/trading/src/index.js';
import type { Market, Mode } from '../../../packages/shared/src/index.js';
import type { Runtime } from './context.js';
import { createHash } from 'node:crypto';
import { runTool } from '../../../packages/agents/src/index.js';
async function settlementTool(kind: 'merge' | 'redeem', id: string, mode: Mode, handler: (signal: AbortSignal) => Promise<void>) {
  const jobId = `settlement-${createHash('sha256').update(id).digest('hex')}`;
  const result = await runTool('portfolio', kind, jobId, { operationId: id, mode }, async (_input, context) => {
    await handler(context.signal);
    const settlement = (await pool.query('SELECT status FROM settlements WHERE id=$1 AND mode=$2', [id, mode])).rows[0];
    const observedAt = new Date().toISOString(), freshUntil = new Date(Date.now() + 30000).toISOString();
    if (!settlement || ['failed', 'ambiguous', 'submitting'].includes(settlement.status)) return { ok: false, source: `portfolio:${kind}`, observedAt, freshUntil, operationId: context.operationId, error: { code: 'SETTLEMENT_UNCONFIRMED', message: 'Settlement failed or uncertain; inspect persisted operation and reconcile before retry', retryable: false } };
    return { ok: true, source: `portfolio:${kind}`, observedAt, freshUntil, operationId: context.operationId, data: { operationId: id, status: settlement.status } };
  });
  if (!result.ok) throw new Error('Settlement tool failed; persisted operation requires reconciliation');
  return result;
}
export async function walletCheck(runtime: Runtime) {
  const { settings } = await readSettings();
  const checkedAt = new Date().toISOString();
  if (!settings.walletAddress || !env.POLYMARKET_WALLET_ADDRESS || settings.walletAddress.toLowerCase() !== env.POLYMARKET_WALLET_ADDRESS.toLowerCase() || !runtime.live) {
    const state = { ready: false, checkedAt, reason: 'Alamat Settings harus cocok dengan wallet server; signer, RPC dan kredensial CLOB wajib tersedia' };
    await writeState('wallet', state); return state;
  }
  try {
    const [result, balance, positions, orders] = await Promise.all([runtime.live.walletReadiness(settings.walletAddress), runtime.live.getBalances(), runtime.live.getPositions(), runtime.live.getOrders()]);
    const amount = d(balance.balance).div(1000000);
    const journal = await pool.query("SELECT id FROM journals WHERE mode='live' LIMIT 1");
    if (!journal.rowCount && !positions.length && !orders.length) await transaction(client => postJournal(client, 'live-initial-capital', 'live', 'deposit', 'Saldo awal wallet terverifikasi, bukan keuntungan', [{ account: 'cash', amount: amount.toFixed() }, { account: 'capital', amount: amount.negated().toFixed() }], { observedAt: checkedAt }));
    const ready = result.ready && !!settings.live && d(settings.live.capital).lte(amount) && result.gaslessConfigured;
    const state = { ready, checkedAt, reason: ready ? 'Akses, autentikasi, saldo dan allowance terverifikasi' : 'Modal, allowance, akses, relayer atau wallet belum siap', balance: amount.toFixed(), geoblock: result.geoblock, approvals: result.approvals };
    await writeState('wallet', state); return state;
  } catch { const state = { ready: false, checkedAt, reason: 'Pemeriksaan wallet gagal; live tetap diblokir' }; await writeState('wallet', state); return state; }
}
export async function markPositions(mode: Mode, runtime: Runtime) {
  const rows = (await pool.query("SELECT p.*,m.payload market FROM positions p JOIN markets m ON m.id=p.market_id WHERE p.mode=$1 AND p.shares>0", [mode])).rows;
  for (const row of rows) {
    try {
      const market: Market = row.market, book = await runtime.public.getBook(row.token_id);
      const quote = executableDepth(book.bids, row.shares, '0.0001', 'SELL');
      if (!quote.complete || Date.now()-Date.parse(book.observedAt)>30000) { await pool.query('UPDATE positions SET mark=NULL,marked_at=NULL WHERE id=$1', [row.id]); continue; }
      let remaining = d(row.shares), fee = d(0);
      for (const level of book.bids) { const shares = d(level.size).lt(remaining) ? d(level.size) : remaining; if (shares.lte(0)) continue; fee = fee.plus(feeFor(market, level.price, shares.toFixed())); remaining = remaining.minus(shares); if (remaining.lte(0)) break; }
      const mark = d(quote.cost).minus(fee).div(row.shares);
      await pool.query('UPDATE positions SET mark=$1,marked_at=$2,updated_at=now() WHERE id=$3', [mark.toFixed(), book.observedAt, row.id]);
    } catch { await pool.query('UPDATE positions SET mark=NULL,marked_at=NULL WHERE id=$1', [row.id]); }
  }
}
async function completeSettlement(id: string, mode: Mode, market: Market, quantity: string, kind: 'merge' | 'redeem', payout: [string, string], fee: string) {
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73011)');
    const settlement = (await client.query('SELECT * FROM settlements WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!settlement || settlement.status === 'confirmed') return;
    const rows = (await client.query('SELECT * FROM positions WHERE mode=$1 AND market_id=$2 AND shares>0 FOR UPDATE', [mode, market.id])).rows;
    let basis = d(0), cash = d(0);
    const changes: { id: string; shares: string; basis: string; profit: string; fee: string }[] = [];
    for (const position of rows) {
      if (kind === 'merge' && position.strategy !== 'arbitrage') continue;
      const qty = kind === 'merge' ? d(quantity) : d(position.shares);
      if (qty.gt(position.shares) || d(position.reserved_shares).gt(0)) throw new Error('Settlement conflicts with balance/reserved shares');
      const removed = d(position.cost_basis).mul(qty).div(position.shares).toDecimalPlaces(12);
      const received = kind === 'merge' ? qty.div(2) : qty.mul(position.token_id === market.yesToken ? payout[0] : payout[1]);
      const eligibleCount = kind === 'merge' ? rows.filter(p => p.strategy === 'arbitrage').length : rows.length;
      const allocatedFee = changes.length === eligibleCount - 1 ? d(fee).minus(changes.reduce((sum, p) => sum.plus(p.fee), d(0))) : d(fee).div(eligibleCount).toDecimalPlaces(12);
      basis = basis.plus(removed); cash = cash.plus(received);
      changes.push({ id: position.id, shares: qty.toFixed(), basis: removed.toFixed(), profit: received.minus(removed).toFixed(), fee: allocatedFee.toFixed() });
    }
    if (!changes.length || (kind === 'merge' && changes.length !== 2)) throw new Error('Both complementary balances must be confirmed');
    const profit = cash.minus(basis);
    await postJournal(client, `settlement:${id}`, mode, kind, `${kind} terkonfirmasi`, [{ account: 'cash', amount: cash.minus(fee).toFixed() }, { account: 'position', amount: basis.negated().toFixed() }, { account: 'realized-pnl', amount: profit.negated().toFixed() }, { account: 'fees', amount: fee }], { marketId: market.id, settlementId: id, strategy: kind === 'merge' ? 'arbitrage' : 'prediction' });
    for (const p of changes) await client.query("UPDATE positions SET shares=shares-$1,cost_basis=cost_basis-$2,realized_pnl=realized_pnl+$3,fees=fees+$4,status=CASE WHEN shares=$1 THEN 'closed' ELSE 'open' END,closed_at=CASE WHEN shares=$1 THEN now() ELSE NULL END,updated_at=now() WHERE id=$5", [p.shares, p.basis, p.profit, p.fee, p.id]);
    await client.query("UPDATE settlements SET status='confirmed',updated_at=now() WHERE id=$1", [id]);
  });
}
export async function manageSettlements(mode: Mode, runtime: Runtime) {
  const { settings } = await readSettings();
  const rows = (await pool.query("SELECT DISTINCT m.payload market FROM markets m JOIN positions p ON p.market_id=m.id WHERE p.mode=$1 AND p.shares>0", [mode])).rows;
  for (const row of rows) {
    const market: Market = row.market;
    const positions = (await pool.query("SELECT * FROM positions WHERE mode=$1 AND market_id=$2 AND shares>0 ORDER BY token_id", [mode, market.id])).rows;
    if (positions.some(p => d(p.reserved_shares).gt(0))) continue;
    const yes = positions.find(p => p.token_id === market.yesToken && p.strategy === 'arbitrage'), no = positions.find(p => p.token_id === market.noToken && p.strategy === 'arbitrage');
    let kind: 'merge' | 'redeem' | null = null, shares = '0', payout: [string,string] = ['0','0'];
    if (yes && no) { kind = 'merge'; shares = d(yes.shares).lt(no.shares) ? yes.shares : no.shares; }
    else if (Date.parse(market.endDate) < Date.now()) {
      const resolution = await runtime.public.getResolution(market.id);
      if (resolution.resolved && resolution.outcomePrices.every(p => p !== null && p !== undefined)) { kind = 'redeem'; payout = [resolution.outcomePrices[0]!, resolution.outcomePrices[1]!]; shares = positions.reduce((s,p) => s.plus(p.shares), d(0)).toFixed(); }
      else { await pool.query("UPDATE positions SET status=$1 WHERE mode=$2 AND market_id=$3 AND shares>0", [String(resolution.resolutionStatus ?? '').includes('disput') ? 'disputed' : 'pending-resolution', mode, market.id]); continue; }
    }
    if (!kind || d(shares).lte(0)) continue;
    const unresolved = await pool.query("SELECT * FROM settlements WHERE mode=$1 AND market_id=$2 AND status NOT IN ('confirmed','failed')", [mode, market.id]);
    if (unresolved.rowCount) {
      if (mode === 'paper') { const existing = unresolved.rows[0]; await completeSettlement(existing.id, mode, market, existing.shares, existing.kind, existing.payload.payout, settings.paper.mergeCost); }
      continue;
    }
    const fingerprint = positions.map(p => `${p.id}:${p.shares}:${p.cost_basis}`).join('|');
    const operationFingerprint = `${mode}:${kind}:${market.id}:${fingerprint}`;
    const previous = (await pool.query("SELECT id,status,payload,updated_at FROM settlements WHERE id=$1 OR (mode=$2 AND market_id=$3 AND payload->>'operationFingerprint'=$1) ORDER BY created_at DESC LIMIT 1", [operationFingerprint,mode,market.id])).rows[0];
    let attempt = 1;
    if (previous) {
      const previousAttempt = Number(previous.payload.attempt);
      // Only this process's explicit pre-dispatch failure marker permits another attempt.
      if (previous.status !== 'failed' || previous.payload.failedBeforeDispatch !== true || !Number.isInteger(previousAttempt) || previousAttempt < 1 || previousAttempt >= 3) continue;
      if (Date.now()-new Date(previous.updated_at).getTime() < 30000*previousAttempt) continue;
      attempt = previousAttempt+1;
    }
    const id = attempt === 1 ? operationFingerprint : `${operationFingerprint}:attempt:${attempt}`;
    const inserted = await pool.query("INSERT INTO settlements(id,mode,market_id,kind,status,shares,payload) VALUES($1,$2,$3,$4,'prepared',$5,$6) ON CONFLICT DO NOTHING RETURNING id", [id, mode, market.id, kind, shares, JSON.stringify({ payout, operationFingerprint, attempt })]);
    if (mode === 'paper') {
      if (inserted.rowCount) await settlementTool(kind, id, mode, async signal => { signal.throwIfAborted(); await completeSettlement(id, mode, market, shares, kind, payout, settings.paper.mergeCost); });
      continue;
    }
    if (!runtime.live || !inserted.rowCount) continue;
    const live = runtime.live;
    await settlementTool(kind, id, mode, async signal => {
      let attempted = false;
      try {
        signal.throwIfAborted();
        const reconciliation = await readState<{ok:boolean;at:string}>('live-reconciliation');
        if (!reconciliation?.ok || Date.now()-Date.parse(reconciliation.at)>30000) throw new Error('Fresh balanced live reconciliation required');
        const readiness = await live.walletReadiness(settings.walletAddress!);
        if (!readiness.ready || !readiness.gaslessConfigured) throw new Error('Verified gasless settlement configuration required');
        const beforeCash = d((await live.getBalances()).balance).div(1000000).toFixed();
        const beforePositions = await live.getPositions();
        const beforeTokens = [market.yesToken, market.noToken].map(token => ({ token, shares: beforePositions.filter(p => p.assetId === token).reduce((sum, p) => sum.plus(p.currentSize), d(0)).toFixed() }));
        if (beforeTokens.some(p => !d(p.shares).eq(positions.filter(position => position.token_id === p.token).reduce((sum, position) => sum.plus(position.shares), d(0))))) throw new Error('Wallet contains untracked or mismatched token holdings');
        const expectedTokens = beforeTokens.map(p => ({ token: p.token, shares: kind === 'merge' ? d(p.shares).minus(shares).toFixed() : '0' }));
        const expectedPayout = kind === 'merge' ? shares : positions.reduce((sum, p) => sum.plus(d(p.shares).mul(p.token_id === market.yesToken ? payout[0] : payout[1])), d(0)).toFixed();
        if (expectedTokens.some(p => d(p.shares).lt(0))) throw new Error('Wallet token balance insufficient');
        signal.throwIfAborted();
        await pool.query("UPDATE settlements SET status='submitting',payload=payload||$2::jsonb,updated_at=now() WHERE id=$1", [id, JSON.stringify({ beforeCash, expectedCash: d(beforeCash).plus(expectedPayout).toFixed(), expectedTokens, gaslessConfirmed: true, positionFingerprint: fingerprint })]);
        signal.throwIfAborted();
        attempted = true;
        const handle = kind === 'merge' ? await live.merge(market.conditionId, shares) : await live.redeem(market.conditionId);
        await pool.query("UPDATE settlements SET status='pending',external_id=$1,payload=payload||$2::jsonb,updated_at=now() WHERE id=$3", [handle.transactionHash ?? handle.transactionId, JSON.stringify({ transactionHash: handle.transactionHash, transactionId: handle.transactionId }), id]);
        // Subsequent portfolio pulses poll the durable identity; never hold the operations queue waiting for chain finality.
      } catch {
        await pool.query("UPDATE settlements SET status=$2,payload=payload||$3::jsonb,updated_at=now() WHERE id=$1", [id, attempted ? 'ambiguous' : 'failed', JSON.stringify({failedBeforeDispatch: !attempted})]);
        await audit('portfolio',attempted ? 'Settlement perlu rekonsiliasi' : 'Settlement gagal sebelum dispatch',`Attempt ${attempt}/3; ${attempted ? 'Tidak ada retry otomatis' : 'Retry dibatasi dan menunggu backoff'}`,'warning',id);
      }
    });
  }
  if (mode === 'live' && runtime.live) {
    for (const row of (await pool.query("SELECT s.*,m.payload market FROM settlements s JOIN markets m ON m.id=s.market_id WHERE s.mode='live' AND s.status IN ('pending','verifying','ambiguous')")).rows) {
      let tx = row.payload.transactionHash;
      if (!tx && row.payload.transactionId) {
        try {
          const external = await runtime.live.getRelayerTransaction(row.payload.transactionId);
          tx = external.transactionHash;
          if (tx) await pool.query("UPDATE settlements SET external_id=$1,payload=payload||$2::jsonb,updated_at=now() WHERE id=$3", [tx, JSON.stringify({transactionHash:tx}), row.id]);
        } catch { continue; }
      }
      if (!tx) continue;
      const receipt = await runtime.live.getTransactionReceipt(tx);
      if (receipt.status === 'reverted') await pool.query("UPDATE settlements SET status='failed',updated_at=now() WHERE id=$1", [row.id]);
      else if (receipt.status === 'success' && Number(receipt.confirmations)>=12) {
        if (row.payload.gaslessConfirmed !== true || !row.payload.expectedTokens || !row.payload.expectedCash) continue;
        const [balance, observed] = await Promise.all([runtime.live.getBalances(), runtime.live.getPositions()]);
        const cashMatches = d(balance.balance).div(1000000).eq(row.payload.expectedCash);
        const tokensMatch = (row.payload.expectedTokens as {token:string;shares:string}[]).every(expected => observed.filter(p => p.assetId === expected.token).reduce((sum, p) => sum.plus(p.currentSize), d(0)).eq(expected.shares));
        const current = (await pool.query("SELECT * FROM positions WHERE mode='live' AND market_id=$1 AND shares>0 ORDER BY token_id", [row.market_id])).rows;
        const unchanged = current.map(p => `${p.id}:${p.shares}:${p.cost_basis}`).join('|') === row.payload.positionFingerprint;
        if (cashMatches && tokensMatch && unchanged) await completeSettlement(row.id, 'live', row.market, row.shares, row.kind, row.payload.payout, '0');
      }
    }
  }
}
export async function reconcileLive(runtime: Runtime) {
  if (!runtime.live) return;
  const trackedOrders = (await pool.query("SELECT * FROM orders WHERE mode='live' AND exchange_id IS NOT NULL")).rows;
  const snapshot = await runtime.live.normalizedReconcile();
  let unknown = 0;
  const groups = new Map<string, typeof snapshot.fills>();
  for (const fill of snapshot.fills) {
    const key = `${fill.orderId.toLowerCase()}:${fill.transactionHash ?? fill.tradeId}`;
    groups.set(key, [...(groups.get(key) ?? []), fill]);
  }
  for (const fills of groups.values()) {
    const first = fills[0], order = trackedOrders.find(o => o.exchange_id.toLowerCase() === first.orderId.toLowerCase());
    if (!order) { unknown++; continue; }
    const exchange = order.signed_payload?.exchangeAddress;
    const legacy = await pool.query("SELECT id FROM fills WHERE id=ANY($1::text[]) AND status='confirmed'", [fills.map(f => `live:${f.tradeId}:${f.orderId}`)]);
    if (legacy.rowCount) { unknown++; continue; }
    let accounted = false;
    if (fills.every(f => f.confirmed) && first.transactionHash && exchange) {
      try {
        const evidence = await runtime.live.getOrderSettlement(first.transactionHash, first.orderId, exchange);
        const logs = evidence.fills.filter(f => f.tokenId === order.token_id && f.side === order.intent.side);
        const expectedShares = fills.reduce((total, f) => total.plus(f.shares), d(0));
        if (Number(evidence.confirmations) >= 12 && logs.length && logs.reduce((total, f) => total.plus(f.shares), d(0)).eq(expectedShares)) {
          for (const log of logs) await settleFill({ id: `live:${log.transactionHash}:${log.logIndex}`, orderId: order.id, shares: log.shares, price: d(log.notionalUsd).div(log.shares).toFixed(), notional: log.notionalUsd, fee: log.actualFeeUsd });
          accounted = true;
          for (const fill of fills) await pool.query("DELETE FROM fills WHERE id=$1 AND status<>'confirmed'", [`live:${fill.tradeId}:${fill.orderId}`]);
        }
      } catch { unknown++; }
    }
    if (!accounted) for (const fill of fills) {
      if (fill.status.toUpperCase() !== 'FAILED') unknown++;
      await pool.query("INSERT INTO fills(id,order_id,mode,status,shares,price,fee) VALUES($1,$2,'live',$3,$4,$5,NULL) ON CONFLICT(id) DO UPDATE SET status=CASE WHEN fills.status='confirmed' THEN 'confirmed' ELSE excluded.status END", [`live:${fill.tradeId}:${fill.orderId}`, order.id, fill.confirmed ? 'awaiting-fee' : fill.status.toLowerCase(), fill.shares, fill.price]);
    }
  }
  const orders = (await pool.query("SELECT * FROM orders WHERE mode='live' AND status NOT IN ('filled','rejected','cancelled','expired')")).rows;
  const knownOpenIds = new Set(orders.flatMap(order => order.exchange_id ? [order.exchange_id.toLowerCase()] : []));
  for (const external of snapshot.orders) if (!knownOpenIds.has(external.id.toLowerCase())) unknown++;
  for (const order of orders) {
    if (!order.exchange_id) { unknown++; continue; }
    let external;
    try { external = snapshot.orders.find(o => o.id.toLowerCase() === order.exchange_id.toLowerCase()) ?? await runtime.live.getOrder(order.exchange_id); } catch { unknown++; continue; }
    const pending = (await pool.query("SELECT id FROM fills WHERE order_id=$1 AND status NOT IN ('confirmed','failed')", [order.id])).rowCount;
    if (external.assetId !== order.token_id || external.side !== order.intent.side || !d(external.originalSize).eq(order.intent.shares) || !d(external.sizeMatched).eq(order.filled_shares) || pending) { unknown++; continue; }
    if (['CANCELED','CANCELLED','EXPIRED','UNMATCHED'].includes(external.status.toUpperCase())) await releaseOrder(order.id, external.status.toUpperCase() === 'EXPIRED' ? 'expired' : 'cancelled', 'Status dan fills exchange sudah direkonsiliasi');
    else if (external.status.toUpperCase() === 'MATCHED' && ['FAK','FOK'].includes(order.intent.orderType)) await releaseOrder(order.id, 'cancelled', 'Order immediate final; seluruh matched fills terkonfirmasi');
    else if (external.status.toUpperCase() === 'LIVE') await pool.query("UPDATE orders SET status=CASE WHEN filled_shares>0 THEN 'partial' ELSE 'open' END WHERE id=$1", [order.id]);
  }
  const { settings } = await readSettings(), m = await metrics('live', settings);
  if (d(snapshot.balances.balance).div(1000000).minus(m.cash).abs().gt('0.00001')) unknown++;
  const tracked = (await pool.query("SELECT token_id,sum(shares)::text shares FROM positions WHERE mode='live' GROUP BY token_id")).rows;
  const observedTokens = new Set<string>();
  for (const position of snapshot.positions) {
    const token = position.assetId, size = position.currentSize;
    observedTokens.add(token);
    if (!d(tracked.find(r => r.token_id === token)?.shares ?? 0).eq(size)) unknown++;
  }
  for (const row of tracked) if (d(row.shares).gt(0) && !observedTokens.has(row.token_id)) unknown++;
  const unsettled = await pool.query("SELECT id FROM settlements WHERE mode='live' AND status NOT IN ('confirmed','failed')");
  unknown += unsettled.rowCount ?? 0;
  await writeState('live-reconciliation', { ok: unknown === 0, at: new Date().toISOString(), unresolved: unknown });
  if (unknown) await audit('portfolio', 'Rekonsiliasi live tertunda', `${unknown} selisih/fee/operasi belum memiliki bukti final; entry baru diblokir`, 'warning');
}
export async function recordEquity(mode: Mode) {
  const { settings } = await readSettings(), m = await metrics(mode, settings);
  if (m.equity !== null && m.totalPnl !== null) await pool.query('INSERT INTO equity(mode,value,pnl,drawdown) VALUES($1,$2,$3,$4)', [mode, m.equity, m.totalPnl, m.drawdown]);
  return m;
}
