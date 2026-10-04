import { pool } from '../../../packages/db/src/index.js';
import { releaseOrder } from '../../../packages/core/src/ledger.js';
import { audit } from '../../../packages/core/src/state.js';

/** Called only while holding the single-wallet worker lease. */
export async function recoverInterruptedOperations() {
  const preparing = await pool.query("SELECT id FROM orders WHERE mode='live' AND status='preparing'");
  for (const order of preparing.rows) await releaseOrder(order.id, 'rejected', 'Restart sebelum dispatch; reservasi dilepas, persetujuan baru diperlukan');
  const orders = await pool.query("UPDATE orders SET status='ambiguous',message='Restart during submission; reconcile native hash before retry',updated_at=now() WHERE mode='live' AND status='submitting' RETURNING id");
  const uncertain = await pool.query("UPDATE settlements SET status='ambiguous',updated_at=now() WHERE mode='live' AND status='submitting' RETURNING id");
  // Only the new preparation contract proves that no external dispatch occurred.
  const prepared = await pool.query(`UPDATE settlements SET status='failed',payload=payload||'{"failedBeforeDispatch":true}'::jsonb,updated_at=now()
    WHERE mode='live' AND status='prepared' AND external_id IS NULL
      AND payload->>'operationFingerprint' IS NOT NULL AND payload->>'attempt' IN ('1','2','3')
      AND payload->>'transactionId' IS NULL AND payload->>'transactionHash' IS NULL RETURNING id`);
  const result = { releasedOrders: preparing.rowCount ?? 0, ambiguousOrders: orders.rowCount ?? 0, retryableSettlements: prepared.rowCount ?? 0, ambiguousSettlements: uncertain.rowCount ?? 0 };
  if (Object.values(result).some(Boolean)) await audit('supervisor', 'Operasi terputus dipulihkan', JSON.stringify(result), 'warning');
  return result;
}
