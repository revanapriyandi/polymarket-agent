import { randomUUID } from 'node:crypto';
import { pool } from '../../../packages/db/src/index.js';
import { readSettings, readControl, audit } from '../../../packages/core/src/state.js';
import { d, metrics } from '../../../packages/core/src/ledger.js';
import { profileVersion, selectedForecastProfiles } from '../../../packages/core/src/profiles.js';
import { cancelOrder } from './execution.js';
import { approve as authorize, execute as executeOrder } from './actions.js';
import { arbitrageQuote, roundShares, feeFor, executableDepth } from '../../../packages/trading/src/index.js';
import type { Market, OrderBook, OrderIntent, Mode, Forecast } from '../../../packages/shared/src/index.js';
import type { Runtime } from './context.js';
function proposal(market: Market, tokenId: string, shares: string, price: string, mode: Mode, strategy: 'arbitrage' | 'prediction', version: number, profile: string): OrderIntent {
  return { operationId: randomUUID(), mode, strategy, marketId: market.id, conditionId: market.conditionId, eventId: market.eventId, tokenId, side: 'BUY', shares, limitPrice: price, orderType: 'FOK', postOnly: false, policyVersion: version, profileVersion: profile, rulesHash: market.rulesHash, createdAt: new Date().toISOString(), maxCost: d(shares).mul(price).plus(feeFor(market, price, shares)).toFixed() };
}
async function opportunity(market: Market, strategy: string, status: string, payload: unknown) { await pool.query('INSERT INTO opportunities(market_id,strategy,status,payload,expires_at) VALUES($1,$2,$3,$4,now()+interval \'30 seconds\')', [market.id, strategy, status, JSON.stringify(payload)]); }
export async function considerMarket(market: Market, yes: OrderBook, no: OrderBook, runtime: Runtime) {
  const { settings, version } = await readSettings(), control = await readControl(), mode = control.mode as Mode, risk = mode === 'paper' ? settings.paper : settings.live;
  if (!risk || control.state !== 'running' || !market.fee || !market.acceptingOrders || market.closed || d(market.liquidity).lt(risk.minimumLiquidity) || d(market.volume).lt(risk.minimumVolume)) return { considered: false, reason: 'Universe, likuiditas atau kontrol belum memenuhi syarat' };
  const existing = await pool.query('SELECT id::text FROM positions WHERE mode=$1 AND market_id=$2 UNION SELECT id FROM orders WHERE mode=$1 AND market_id=$2 AND status NOT IN (\'rejected\',\'cancelled\',\'expired\')', [mode, market.id]);
  if (existing.rowCount) return { considered: false, reason: 'Posisi atau transaksi pasar sudah tercatat' };
  const budget = d(risk.capital).mul(risk.eventExposure).minus(risk.mergeCost).mul('.98');
  if (budget.lte(0) || !yes.asks.length || !no.asks.length) return { considered: false, reason: 'Dana atau order book tidak cukup' };
  const shares = roundShares(budget.div(d(yes.asks[0].price).plus(no.asks[0].price)).toFixed());
  if (settings.strategyEnabled.arbitrage && d(shares).gt(0)) {
    const quote = arbitrageQuote(market, yes, no, shares, risk.mergeCost, risk.slippageBps);
    if (quote) {
      await opportunity(market, 'arbitrage', d(quote.netProfit).gt(0) ? 'candidate' : 'rejected', { mode, question: market.question, ...quote, reason: d(quote.netProfit).gt(0) ? 'Pasangan memiliki edge setelah biaya' : 'Harga pasangan dan biaya melebihi payout' });
      if (d(quote.netProfit).gte('.01')) {
        const profile = await profileVersion('arbitrage', settings), intents = [proposal(market, market.yesToken, quote.shares, quote.yesLimit, mode, 'arbitrage', version, profile), proposal(market, market.noToken, quote.shares, quote.noLimit, mode, 'arbitrage', version, profile)];
        const result = await authorize(intents, market, [yes, no]);
        if (result.approved) { for (const i of intents) await executeOrder(i.operationId, runtime); await recoverArbitrage(market, mode, runtime); return { considered: true, executed: true, strategy: 'arbitrage' }; }
        await audit('risk', 'Arbitrase ditolak', result.reason); return { considered: true, reason: result.reason };
      }
    }
  }
  if (settings.strategyEnabled.prediction) {
    const assignment = (await pool.query("SELECT * FROM assignments WHERE role='forecast'")).rows[0];
    if (!assignment) return { considered: true, reason: 'Model forecast belum ditugaskan' };
    const allowed = [assignment.primary_id, ...(assignment.fallback_enabled ? assignment.fallback_ids : [])];
    const record = (await pool.query('SELECT f.*,p.config,p.version current_version FROM forecasts f JOIN providers p ON p.id=f.provider_id WHERE f.market_id=$1 AND f.provider_id=ANY($2::uuid[]) AND f.rules_hash=$3 AND p.config->>\'enabled\'=\'true\' ORDER BY f.created_at DESC LIMIT 1', [market.id, allowed, market.rulesHash])).rows[0];
    if(!record || record.provider_version !== record.current_version) return {considered:true,reason:'Forecast model sudah berubah atau belum tersedia'};
    const profile = await profileVersion('prediction', settings, {providerId:record.provider_id,providerVersion:record.provider_version,model:record.config.model,protocol:record.config.protocol});
    if (record.profile_version !== profile) return {considered:true,reason:'Forecast perlu dievaluasi ulang untuk profil baru'};
    const forecast: Forecast | undefined = record?.payload;
    if (!forecast || forecast.abstain || Date.parse(forecast.expiresAt)<Date.now()) return { considered: true, reason: 'Menunggu forecast dan bukti yang memenuhi syarat' };
    const candidates = [{ token: market.yesToken, book: yes, conservative: forecast.lower }, { token: market.noToken, book: no, conservative: 1-forecast.upper }];
    for (const candidate of candidates) {
      const price = candidate.book.asks[0]?.price; if (!price) continue;
      const quantity = roundShares(budget.div(d(price).plus(feeFor(market, price, '1'))).toFixed());
      const depth = executableDepth(candidate.book.asks, quantity, '.9999', 'BUY');
      if (!depth.complete || d(quantity).lt(candidate.book.minOrderSize)) continue;
      const allIn = d(depth.cost).plus(feeFor(market, depth.averagePrice, quantity)).div(quantity).plus(d(risk.slippageBps).div(10000)), edge = d(candidate.conservative).minus(allIn);
      if (edge.lt(risk.minimumEdge)) continue;
      await opportunity(market, 'prediction', 'candidate', { mode, question: market.question, probability: forecast.probability, lower: forecast.lower, upper: forecast.upper, edge: edge.toFixed(), evidence: forecast.supportingSources });
      const intent = proposal(market, candidate.token, quantity, depth.worstPrice, mode, 'prediction', version, profile), approval = await authorize([intent], market, [candidate.book]);
      if (approval.approved) await executeOrder(intent.operationId, runtime);
      return { considered: true, executed: approval.approved, reason: approval.reason };
    }
    return { considered: true, reason: 'Edge setelah biaya dan ketidakpastian di bawah batas' };
  }
  return { considered: true, reason: 'Belum ada peluang dengan keuntungan bersih yang layak' };
}
export async function recoverArbitrage(market: Market, mode: Mode, runtime: Runtime) {
  const positions = (await pool.query("SELECT * FROM positions WHERE mode=$1 AND market_id=$2 AND strategy='arbitrage' AND shares>0", [mode, market.id])).rows;
  if (positions.length !== 1) return;
  const pending = await pool.query("SELECT id FROM orders WHERE mode=$1 AND market_id=$2 AND status NOT IN ('filled','cancelled','rejected','expired')", [mode, market.id]);
  if (pending.rowCount) return;
  const p = positions[0], { settings, version } = await readSettings(), risk = mode === 'paper' ? settings.paper : settings.live;
  if (!risk) return;
  const book = await runtime.public.getBook(p.token_id), quote = executableDepth(book.bids, p.shares, '.0001', 'SELL');
  const loss = d(p.cost_basis).plus(p.fees).minus(quote.cost).plus(feeFor(market, quote.averagePrice, p.shares));
  if (!quote.complete || loss.gt(risk.maxRecoveryLoss)) {
    await pool.query("UPDATE positions SET status='recovery' WHERE id=$1", [p.id]);
    await audit('risk', 'Pemulihan arbitrase menunggu', 'Satu sisi terisi; penjualan sekarang melewati batas biaya pemulihan atau kedalaman book', 'warning'); return;
  }
  const intent: OrderIntent = { ...proposal(market, p.token_id, p.shares, quote.worstPrice, mode, 'arbitrage', version, p.profile_version), side: 'SELL', strategy: 'exit', recoveryFor: 'arbitrage', maxCost: '0' };
  const approval = await authorize([intent], market, [book]); if (approval.approved) await executeOrder(intent.operationId, runtime);
}
export async function manageExits(mode: Mode, runtime: Runtime) {
  const { settings, version } = await readSettings(), risk = mode === 'paper' ? settings.paper : settings.live; if (!risk) return;
  const m = await metrics(mode, settings);
  const riskHit = d(m.dailyPnl).lte(d(risk.capital).mul(risk.dailyLoss).negated()) || d(m.drawdown).gte(risk.maxDrawdown);
  if (riskHit) {
    await pool.query("UPDATE controls SET state='risk-stopped',reason='Batas kerugian atau drawdown tercapai',updated_at=now() WHERE id=1 AND state!='emergency'");
    const pendingBuys = (await pool.query("SELECT id FROM orders WHERE mode=$1 AND intent->>'side'='BUY' AND status NOT IN ('filled','cancelled','rejected','expired')",[mode])).rows;
    for (const order of pendingBuys) {
      try { await cancelOrder(order.id,runtime); }
      catch { await audit('risk','Pembatalan BUY setelah batas risiko tertunda','Reservasi dipertahankan sampai rekonsiliasi terkonfirmasi','warning',order.id); }
    }
  }
  const permitted = await Promise.all((await selectedForecastProfiles()).map(async model => ({...model,profileVersion:await profileVersion('prediction',settings,model)})));
  const rows = (await pool.query("SELECT p.*,m.payload market FROM positions p JOIN markets m ON m.id=p.market_id WHERE p.mode=$1 AND p.shares>0 AND p.reserved_shares=0", [mode])).rows;
  for (const p of rows) {
    let market: Market = p.market;
    if (p.strategy === 'arbitrage') { await recoverArbitrage(market, mode, runtime); continue; }
    if (Date.parse(market.endDate)<=Date.now()) continue;
    market = await runtime.public.getMarket(market.id);
    const latest = (await pool.query('SELECT f.payload,f.rules_hash FROM forecasts f JOIN providers provider ON provider.id=f.provider_id AND provider.version=f.provider_version WHERE f.market_id=$1 AND provider.config->>\'enabled\'=\'true\' AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS p("providerId" uuid,"providerVersion" integer,"profileVersion" text) WHERE f.provider_id=p."providerId" AND f.provider_version=p."providerVersion" AND f.profile_version=p."profileVersion") ORDER BY f.created_at DESC LIMIT 1', [market.id,JSON.stringify(permitted)])).rows[0];
    const expiresAt = latest ? Date.parse(latest.payload.expiresAt) : NaN;
    const stale = !latest || !Number.isFinite(expiresAt) || expiresAt<Date.now() || latest.rules_hash!==market.rulesHash;
    const heldTooLong = Date.now()-new Date(p.opened_at).getTime()>risk.maxHoldingHours*3600000;
    const book = await runtime.public.getBook(p.token_id), quote = executableDepth(book.bids, p.shares, '.0001', 'SELL');
    const fair = latest ? (p.token_id === market.yesToken ? latest.payload.lower : 1-latest.payload.upper) : 0;
    const edgeGone = quote.complete && d(fair).lte(d(quote.averagePrice).plus(feeFor(market,quote.averagePrice,'1')));
    if (!riskHit && !heldTooLong && !stale && !edgeGone) continue;
    if (!quote.complete || d(p.shares).lt(book.minOrderSize)) { await audit('portfolio','Exit menunggu likuiditas','Posisi tetap dipantau; tidak ada market order tanpa batas harga','warning'); continue; }
    const intent: OrderIntent = { ...proposal(market,p.token_id,p.shares,quote.worstPrice,mode,'prediction',version,p.profile_version), side:'SELL',strategy:'exit',maxCost:'0',recoveryFor:'prediction' };
    const approved = await authorize([intent],market,[book]); if(approved.approved) await executeOrder(intent.operationId,runtime);
  }
}
