import { createHash } from 'node:crypto';
import { transaction } from '../../db/src/index.js';
import { d, metrics } from './ledger.js';
import { evaluate } from './evaluation.js';
import { env } from './config.js';
import { feeFor } from '../../trading/src/math.js';
import { entryFeedGuard } from './market-stream.js';
import { ENTRY_BOOK_MAX_AGE_MS } from '../../shared/src/realtime.js';
import type { OrderIntent, Market, OrderBook, Settings } from '../../shared/src/index.js';
export const hashIntent = (intent: OrderIntent) => createHash('sha256').update(JSON.stringify(intent)).digest('hex');
export async function authorize(intents: OrderIntent[], market: Market, books: OrderBook[]): Promise<{ approved: boolean; reason: string }> {
  if (!intents.length || intents.length > 2) throw new Error('Invalid intent group');
  const first = intents[0];
  const positive = (value: string) => { try { return d(value).isFinite() && d(value).gt(0); } catch { return false; } };
  const invalid = intents.some(i => !['paper','live'].includes(i.mode) || !['arbitrage','prediction','exit'].includes(i.strategy)
    || !['BUY','SELL'].includes(i.side) || !['GTC','GTD','FOK','FAK'].includes(i.orderType)
    || !i.operationId || !i.profileVersion || typeof i.postOnly !== 'boolean'
    || i.mode !== first.mode || i.strategy !== first.strategy || i.profileVersion !== first.profileVersion
    || i.marketId !== market.id || i.eventId !== market.eventId || i.conditionId !== market.conditionId
    || !positive(i.shares) || !positive(i.limitPrice) || !Number.isFinite(Date.parse(i.createdAt))
    || Date.parse(i.createdAt) > Date.now()+1000
    || (i.side === 'BUY' ? i.strategy === 'exit' || !positive(i.maxCost) : i.strategy !== 'exit' || !['arbitrage','prediction'].includes(i.recoveryFor ?? '') || i.maxCost !== '0'));
  if (invalid || new Set(intents.map(i=>i.operationId)).size !== intents.length
    || (intents.length === 2 && (first.strategy !== 'arbitrage' || new Set(intents.map(i=>i.tokenId)).size !== 2))) {
    return { approved:false, reason:'Identitas, kelompok, atau nilai usulan tidak valid' };
  }
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73011)');
    const row = (await client.query('SELECT * FROM settings WHERE id=1 FOR UPDATE')).rows[0], control = (await client.query('SELECT * FROM controls WHERE id=1 FOR UPDATE')).rows[0];
    const settings: Settings = row.payload, mode = intents[0].mode, risk = mode === 'paper' ? settings.paper : settings.live;
    const current = await metrics(mode, settings, client);
    let reason = '';
    const exit = intents.every(i => i.side === 'SELL');
    const existing = await client.query('SELECT id FROM orders WHERE id=ANY($1::text[])', [intents.map(i => i.operationId)]);
    if (existing.rowCount) return { approved: false, reason: 'Operasi sudah diproses; gunakan rekonsiliasi' };
    if (!risk || d(risk.capital).lte(0)) reason = 'Modal dan batas risiko belum diisi';
    else if (control.mode !== mode) reason = 'Mode berubah';
    else if (!exit && control.state !== 'running') reason = `Entry dihentikan: ${control.state}`;
    else if (intents.some(i => i.mode !== mode || i.policyVersion !== row.version || i.rulesHash !== market.rulesHash || i.marketId !== market.id)) reason = 'Versi kebijakan atau aturan pasar berubah';
    else if (!market.active || market.closed || market.resolved || !market.acceptingOrders || market.negRisk) reason = 'Pasar tidak menerima strategi ini';
    else if (!market.fee || !d(market.fee.rate).isFinite() || d(market.fee.rate).lt(0) || !Number.isFinite(market.fee.exponent)) reason = 'Fee pasar belum terverifikasi';
    else if (!exit && !settings.strategyEnabled[intents[0].strategy as 'arbitrage'|'prediction']) reason = 'Strategi dinonaktifkan oleh pemilik';
    else if (!exit && risk && (d(market.liquidity).lt(risk.minimumLiquidity)||d(market.volume).lt(risk.minimumVolume))) reason = 'Likuiditas atau volume di bawah kebijakan aktif';
    else if (!exit && (!Number.isFinite(Date.parse(market.endDate))||Date.parse(market.endDate)<=Date.now()+86400000||Date.parse(market.endDate)>Date.now()+30*86400000)) reason = 'Horizon pasar di luar universe strategi';
    else if (books.some(b => !Number.isFinite(Date.parse(b.observedAt))||Date.now() - Date.parse(b.observedAt) > (exit ? 10000 : ENTRY_BOOK_MAX_AGE_MS)||Date.parse(b.observedAt)>Date.now()+1000)) reason = 'Order book kadaluwarsa';
    else if (intents.some(i => Date.now() - Date.parse(i.createdAt) > 15_000)) reason = 'Usulan kadaluwarsa';
    else if ((current.unmarkedPositions > 0 || current.equity === null) && !exit) reason = 'Valuasi atau settlement posisi belum lengkap';
    else if (!exit && d(current.dailyPnl).lte(d(risk.capital).mul(risk.dailyLoss).negated())) reason = 'Batas kerugian harian tercapai';
    else if (!exit && d(current.drawdown).gte(risk.maxDrawdown)) reason = 'Batas drawdown tercapai';
    if (!reason && !exit) { const feed = await entryFeedGuard(intents.map(intent => intent.tokenId)); if (!feed.ready) reason = feed.reason; }
    if (reason.includes('tercapai')) await client.query("UPDATE controls SET state='risk-stopped',reason=$1,updated_at=now() WHERE id=1", [reason]);
    const total = intents.filter(i => i.side === 'BUY').reduce((s, i) => s.plus(i.maxCost), d(0));
    if (!reason && risk) {
      for (const intent of intents) {
        if (intent.side === 'BUY') {
          try {
            if (d(intent.maxCost).lt(d(intent.shares).mul(intent.limitPrice).plus(feeFor(market,intent.limitPrice,intent.shares)))) { reason = 'Reservasi tidak mencakup fill limit dan fee'; break; }
          } catch { reason = 'Fee pasar tidak valid'; break; }
        }
        const book = books.find(b => b.tokenId === intent.tokenId);
        if (!book || ![market.yesToken, market.noToken].includes(intent.tokenId) || d(intent.shares).lt(book.minOrderSize) || d(intent.shares).decimalPlaces() > 2 || d(intent.limitPrice).lte(0) || d(intent.limitPrice).gte(1) || !d(intent.limitPrice).mod(book.tickSize).eq(0)) { reason = 'Ukuran, token, tick size, atau harga tidak valid'; break; }
        if (intent.postOnly && !['GTC', 'GTD'].includes(intent.orderType)) { reason = 'Post-only hanya GTC/GTD'; break; }
        if (intent.orderType === 'GTD' && (!intent.expiration || intent.expiration < Math.floor(Date.now() / 1000) + 180)) { reason = 'GTD expiry terlalu dekat'; break; }
        if (intent.side === 'SELL') {
          const pos = (await client.query('SELECT shares-reserved_shares available FROM positions WHERE mode=$1 AND token_id=$2 AND strategy=$3 FOR UPDATE', [mode, intent.tokenId, intent.recoveryFor ?? 'prediction'])).rows[0];
          if (!pos || d(pos.available).lt(intent.shares)) { reason = 'Saham tersedia tidak cukup'; break; }
        }
      }
      if (!reason && !exit) {
        const event = (await client.query("SELECT coalesce((SELECT sum(cost_basis) FROM positions WHERE mode=$1 AND event_id=$2),0)+coalesce((SELECT sum(reserved) FROM orders WHERE mode=$1 AND event_id=$2),0) amount", [mode, market.eventId])).rows[0].amount;
        const blocked = (await client.query("SELECT id FROM orders WHERE mode=$1 AND market_id=$2 AND status IN ('ambiguous','submitting','settling','recovery') LIMIT 1", [mode, market.id])).rowCount;
        const allocation = intents[0].strategy === 'arbitrage' ? risk.arbitrageAllocation : risk.predictionAllocation;
        const strategyExposure = (await client.query('SELECT coalesce((SELECT sum(cost_basis) FROM positions WHERE mode=$1 AND strategy=$2),0)+coalesce((SELECT sum(reserved) FROM orders WHERE mode=$1 AND strategy=$2),0) amount', [mode, intents[0].strategy])).rows[0].amount;
        if (blocked) reason = 'Pasar masih memiliki operasi yang belum direkonsiliasi';
        else if (total.gt(current.available)) reason = 'Dana tersedia tidak cukup';
        else if (d(event).plus(total).gt(d(risk.capital).mul(risk.eventExposure))) reason = 'Exposure event melewati batas (termasuk pasar berkorelasi dalam event yang sama)';
        else if (d(current.exposure).mul(current.capital).plus(total).gt(d(risk.capital).mul(risk.totalExposure))) reason = 'Exposure total melewati batas';
        else if (d(strategyExposure).plus(total).gt(d(risk.capital).mul(allocation))) reason = 'Alokasi strategi melewati batas';
      }
      if (!reason && mode === 'live') {
        if (env.ENABLE_LIVE_EXECUTION !== 'true' || !settings.liveRiskAcknowledged) reason = 'Live belum diaktifkan pada konfigurasi server dan Settings';
        const evaluations = await evaluate(settings);
        if (!exit && !evaluations.find(e => e.strategy === intents[0].strategy && e.profileVersion === intents[0].profileVersion)?.eligible) reason = 'Profil strategi belum lulus gerbang paper';
        const state = (await client.query("SELECT value,updated_at FROM system_state WHERE key='live-reconciliation'")).rows[0];
        if (!state || Date.now() - new Date(state.updated_at).getTime() > 30000 || !state.value.ok) reason = 'Rekonsiliasi live belum bersih dan segar';
      }
    }
    for (const intent of intents) {
      await client.query('INSERT INTO decisions(operation_id,mode,approved,reason,intent) VALUES($1,$2,$3,$4,$5)', [intent.operationId, mode, !reason, reason || 'Lolos kebijakan risiko dan reservasi atomik', JSON.stringify(intent)]);
      if (!reason) {
        await client.query('INSERT INTO permits(operation_id,intent_hash,policy_version,expires_at) VALUES($1,$2,$3,now()+interval \'15 seconds\')', [intent.operationId, hashIntent(intent), row.version]);
        await client.query("INSERT INTO orders(id,mode,market_id,event_id,token_id,strategy,profile_version,status,intent,reserved) VALUES($1,$2,$3,$4,$5,$6,$7,'approved',$8,$9)", [intent.operationId, mode, market.id, market.eventId, intent.tokenId, intent.strategy, intent.profileVersion, JSON.stringify(intent), intent.side === 'BUY' ? intent.maxCost : '0']);
        if (intent.side === 'SELL') await client.query('UPDATE positions SET reserved_shares=reserved_shares+$1 WHERE mode=$2 AND token_id=$3 AND strategy=$4', [intent.shares, mode, intent.tokenId, intent.recoveryFor ?? 'prediction']);
      }
    }
    return { approved: !reason, reason: reason || 'Disetujui' };
  });
}
