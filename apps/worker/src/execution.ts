import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pool, transaction } from '../../../packages/db/src/index.js';
import { d, releaseOrder, settleFill } from '../../../packages/core/src/ledger.js';
import { hashIntent } from '../../../packages/core/src/risk.js';
import { readControl, readSettings, audit, writeState } from '../../../packages/core/src/state.js';
import { executableDepth, feeFor, GatewayError, type PreparedOrder } from '../../../packages/trading/src/index.js';
import type { OrderIntent, Market, Mode } from '../../../packages/shared/src/index.js';
import type { Runtime } from './context.js';
async function consumePermit(id: string): Promise<OrderIntent | null> {
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73011)');
    const row = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row || row.status !== 'approved') return null;
    const permit = (await client.query('SELECT * FROM permits WHERE operation_id=$1 FOR UPDATE', [id])).rows[0], control = (await client.query('SELECT * FROM controls WHERE id=1 FOR UPDATE')).rows[0], settings = (await client.query('SELECT version FROM settings WHERE id=1')).rows[0];
    if (!permit || permit.consumed_at || permit.intent_hash !== hashIntent(row.intent) || permit.policy_version !== settings.version || new Date(permit.expires_at).getTime() < Date.now() || control.mode !== row.mode || (row.intent.side !== 'SELL' && control.state !== 'running')) throw new Error('Permit tidak valid atau kontrol operasi berubah');
    await client.query('UPDATE permits SET consumed_at=now() WHERE operation_id=$1', [id]);
    await client.query("UPDATE orders SET status='preparing',updated_at=now() WHERE id=$1", [id]);
    return row.intent as OrderIntent;
  });
}
async function paperMatch(id: string, runtime: Runtime, initial: boolean) {
  const row = (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  if (!row || !['preparing','open','partial'].includes(row.status)) return;
  const intent: OrderIntent = row.intent, { settings } = await readSettings();
  initial = initial || row.status === 'preparing';
  const persisted = row.signed_payload?.paper;
  if(persisted) {
    await settleFill(persisted);
    if(['FAK','FOK'].includes(intent.orderType)) await releaseOrder(id,'cancelled','Sisa order immediate dibatalkan setelah replay journal');
    return;
  }
  if(!initial && ['FAK','FOK'].includes(intent.orderType)) { await releaseOrder(id,'cancelled','Finalisasi order immediate setelah restart'); return; }
  if (initial) await delay(settings.paperLatencyMs);
  const control = await readControl();
  if (control.mode !== intent.mode || (control.state !== 'running' && intent.side === 'BUY')) { await releaseOrder(id, 'cancelled', 'Kontrol berubah sebelum eksekusi'); return; }
  if (intent.orderType === 'GTD' && intent.expiration! - 60 < Math.floor(Date.now()/1000)) { await releaseOrder(id, 'expired', 'GTD berakhir'); return; }
  const [market, book] = await Promise.all([runtime.public.getMarket(intent.marketId), runtime.public.getBook(intent.tokenId)]);
  if (initial) {
    const permit = (await pool.query('SELECT expires_at,intent_hash,consumed_at FROM permits WHERE operation_id=$1', [id])).rows[0];
    if (!permit?.consumed_at || permit.intent_hash !== hashIntent(intent) || new Date(permit.expires_at).getTime() <= Date.now()) { await releaseOrder(id, 'rejected', 'Persetujuan berakhir sebelum paper match; usulan baru diperlukan'); return; }
  }
  if (market.rulesHash !== intent.rulesHash || !market.acceptingOrders || Date.now()-Date.parse(book.observedAt)>10000 || !d(intent.limitPrice).mod(book.tickSize).eq(0)) { await releaseOrder(id, 'cancelled', 'Aturan, tick atau kesegaran book berubah'); return; }
  const remainder = d(intent.shares).minus(row.filled_shares), levels = intent.side === 'BUY' ? book.asks : book.bids;
  const quote = executableDepth(levels, remainder.toFixed(), intent.limitPrice, intent.side);
  if (initial && intent.postOnly && d(quote.filledShares).gt(0)) { await releaseOrder(id, 'rejected', 'Post-only akan langsung mengambil likuiditas'); return; }
  const failure = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) / 0x100000000;
  if (initial && (failure < settings.paperFailureRate || (intent.orderType === 'FOK' && !quote.complete))) { await releaseOrder(id, 'rejected', failure < settings.paperFailureRate ? 'Kegagalan eksekusi simulasi sesuai konfigurasi' : 'Likuiditas FOK tidak mencukupi setelah latensi'); return; }
  if (d(quote.filledShares).gt(0)) {
    let left = d(quote.filledShares), fees = d(0);
    for (const level of levels) { const shares = d(level.size).lt(left) ? d(level.size) : left; fees = fees.plus(feeFor(market, level.price, shares.toFixed())); left = left.minus(shares); if (left.lte(0)) break; }
    if (intent.side === 'BUY' && d(quote.cost).plus(fees).gt(row.reserved)) { await releaseOrder(id, 'rejected', 'Biaya melewati reservasi risiko'); return; }
    const fill={ id: `paper:${id}:${book.hash}:${row.filled_shares}`, orderId: id, shares: quote.filledShares, price: quote.averagePrice, notional: quote.cost, fee: fees.toFixed() };
    if(['FAK','FOK'].includes(intent.orderType)) await pool.query('UPDATE orders SET signed_payload=$1 WHERE id=$2',[JSON.stringify({paper:fill}),id]);
    await settleFill(fill);
    await audit('execution', 'Paper fill terkonfirmasi', `${intent.side} ${quote.filledShares} saham @ ${quote.averagePrice}; fee ${fees.toFixed()} pUSD`, 'info', id);
  }
  if (['FAK','FOK'].includes(intent.orderType)) await releaseOrder(id, 'cancelled', 'Sisa order immediate dibatalkan');
  else await pool.query("UPDATE orders SET status=CASE WHEN filled_shares>0 THEN 'partial' ELSE 'open' END,updated_at=now() WHERE id=$1 AND status NOT IN ('filled','cancelled')", [id]);
}
export async function executeOrder(id: string, runtime: Runtime) {
  let intent: OrderIntent | null;
  try { intent = await consumePermit(id); } catch { await releaseOrder(id, 'rejected', 'Persetujuan risiko sudah tidak valid'); return; }
  if (!intent) return;
  let submitted = false;
  try {
    if (intent.mode === 'paper') { await paperMatch(id, runtime, true); return; }
    if (!runtime.live) throw new Error('Signer belum tersedia');
    const prepared: PreparedOrder = await runtime.live.prepareOrder(intent);
    const client=await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(73011)');
      await client.query('BEGIN');
      const control = (await client.query('SELECT * FROM controls WHERE id=1 FOR UPDATE')).rows[0], config = (await client.query('SELECT version FROM settings WHERE id=1 FOR UPDATE')).rows[0];
      if (control.mode !== 'live' || (control.state !== 'running' && intent!.side !== 'SELL') || config.version !== intent!.policyVersion) throw new Error('Policy changed before submission');
      const permit = (await client.query('SELECT * FROM permits WHERE operation_id=$1 FOR UPDATE', [id])).rows[0];
      if (!permit?.consumed_at || permit.intent_hash !== hashIntent(intent!) || permit.policy_version !== config.version || new Date(permit.expires_at).getTime() <= Date.now()) throw new Error('Risk authorization expired or changed during preparation');
      prepared.authorizationExpiresAt = new Date(permit.expires_at).toISOString();
      if(!prepared.exchangeOrderHash || !prepared.exchangeAddress) throw new Error('Native order identity required before live submission');
      const saved=await client.query("UPDATE orders SET signed_payload=$1,exchange_id=$3,status='submitting',updated_at=now() WHERE id=$2 AND status='preparing'", [JSON.stringify(prepared), id,prepared.exchangeOrderHash]);
      if(!saved.rowCount) throw new Error('Order state changed before submission');
      await client.query('COMMIT');
    submitted = true;
    const response = await runtime.live.submitPrepared(prepared);
    if (!response.ok) { await client.query('SELECT pg_advisory_unlock(73011)'); await releaseOrder(id, 'rejected', 'Exchange secara eksplisit menolak order'); return; }
    if(response.orderId.toLowerCase()!==prepared.exchangeOrderHash.toLowerCase()) throw new Error('Exchange order ID differs from SDK signing digest');
    await client.query("UPDATE orders SET exchange_id=$1,status='settling',message=$2,updated_at=now() WHERE id=$3", [response.orderId, `Acknowledgement: ${response.status}; menunggu rekonsiliasi fill`, id]);
    await audit('execution', 'Order live dikirim', 'Acknowledgement bukan settlement; saldo menunggu bukti terkonfirmasi', 'info', id);
    } finally { await client.query('ROLLBACK'); await client.query('SELECT pg_advisory_unlock(73011)'); client.release(); }
  } catch (error) {
    if (submitted && !(error instanceof GatewayError && !error.ambiguous)) {
      await pool.query("UPDATE orders SET status='ambiguous',message='Hasil submit belum pasti; dilarang mengirim ulang',updated_at=now() WHERE id=$1", [id]);
      await writeState('live-reconciliation', { ok: false, at: new Date().toISOString(), reason: 'Order ambigu' });
      await audit('execution', 'Order memerlukan rekonsiliasi', 'Tidak ada retry otomatis pada submit yang tidak pasti', 'error', id);
    } else await releaseOrder(id, 'rejected', error instanceof GatewayError ? `Order tidak diterima: ${error.code}; persetujuan baru diperlukan` : 'Validasi, data atau koneksi gagal sebelum submit');
  }
}
export async function resumePaperOrders(runtime: Runtime) {
  const rows = (await pool.query("SELECT id,status FROM orders WHERE mode='paper' AND status IN ('approved','preparing','open','partial') ORDER BY created_at LIMIT 100")).rows;
  for (const row of rows) {
    if (row.status === 'approved') await executeOrder(row.id, runtime);
    else await paperMatch(row.id, runtime, row.status==='preparing');
  }
}
export async function cancelOrder(id: string, runtime: Runtime) {
  const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  if (!order || ['filled','cancelled','rejected','expired'].includes(order.status)) return;
  if (order.mode === 'paper' || ['approved','preparing'].includes(order.status)) { await releaseOrder(id, 'cancelled', 'Dibatalkan oleh kontrol operasi'); return; }
  if (!order.exchange_id || !runtime.live) throw new Error('Order ambigu tidak dapat dilepas sebelum rekonsiliasi');
  const result = await runtime.live.cancel(order.exchange_id);
  if (result.canceled.includes(order.exchange_id)) await pool.query("UPDATE orders SET status='cancel-pending',message='Cancel diterima; reservasi menunggu rekonsiliasi trades',updated_at=now() WHERE id=$1", [id]);
  else await audit('execution', 'Cancel belum terkonfirmasi', 'Reservasi tetap dipertahankan', 'warning', id);
}
export async function cancelOpen(mode: Mode, runtime: Runtime) {
  const rows = (await pool.query("SELECT id FROM orders WHERE mode=$1 AND status NOT IN ('filled','cancelled','rejected','expired')", [mode])).rows;
  for (const row of rows) { try { await cancelOrder(row.id, runtime); } catch { await audit('execution', 'Pembatalan tertunda', 'Rekonsiliasi diperlukan sebelum reservasi dilepas', 'warning', row.id); } }
}
export async function replaceOrder(id: string, price: string, shares: string, runtime: Runtime) {
  const {approve,execute}=await import('./actions.js');
  const old = (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0]; if (!old) throw new Error('Order missing');
  await cancelOrder(id, runtime);
  const cancelled = (await pool.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0];
  if (cancelled.status !== 'cancelled') throw new Error('Cancel belum final; replacement ditunda');
  const { settings, version } = await readSettings(), control = await readControl(), market: Market = await runtime.public.getMarket(old.market_id), book = await runtime.public.getBook(old.token_id);
  const risk = control.mode === 'paper' ? settings.paper : settings.live; if (!risk) throw new Error('Risk missing');
  const intent: OrderIntent = { ...old.intent, operationId: `${id}-replace-${Date.now()}`, shares, limitPrice: price, policyVersion: version, rulesHash: market.rulesHash, createdAt: new Date().toISOString(), maxCost: d(shares).mul(price).plus(feeFor(market, price, shares)).toFixed() };
  const approval = await approve([intent], market, [book]); if (approval.approved) await execute(intent.operationId, runtime); else throw new Error(approval.reason);
}
