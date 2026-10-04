import { pool } from '../../../packages/db/src/index.js';
import { refreshTrends } from '../../../packages/services/src/index.js';
import { researchQueue } from '../../../packages/core/src/queue.js';
import { readControl, audit, readSettings } from '../../../packages/core/src/state.js';
import { profileVersion } from '../../../packages/core/src/profiles.js';
import type { Market } from '../../../packages/shared/src/index.js';
export async function trendRefresh() {
  const markets=(await pool.query('SELECT payload FROM markets ORDER BY updated_at DESC LIMIT 200')).rows.map(r=>r.payload as Market);
  const result=await refreshTrends(markets),control=await readControl(),{settings}=await readSettings();
  const profile=await profileVersion('prediction',settings);
  if(control.state==='running'&&settings.strategyEnabled.prediction)for(const marketId of result.affectedMarketIds){
    await pool.query("UPDATE forecasts SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb(now()::text)) WHERE market_id=$1 AND (payload->>'expiresAt')::timestamptz>now()",[marketId]);
    await researchQueue.add('research',{marketId,mode:control.mode},{jobId:`news-${marketId}-${Date.parse(result.checkedAt)}-${profile}`});
  }
  if(result.affectedMarketIds.length)await audit('research','Berita baru memicu riset ulang',`${result.affectedMarketIds.length} pasar cocok dengan berita; kecocokan belum merupakan bukti transaksi`);
  return {checkedAt:result.checkedAt,items:result.items.length,affectedMarketIds:result.affectedMarketIds,errors:result.errors};
}
