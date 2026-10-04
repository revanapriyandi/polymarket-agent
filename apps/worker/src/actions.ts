import { runTool } from '../../../packages/agents/src/index.js';
import { pool } from '../../../packages/db/src/index.js';
import { authorize } from '../../../packages/core/src/risk.js';
import { executeOrder } from './execution.js';
import type { Market,OrderBook,OrderIntent } from '../../../packages/shared/src/index.js';
import type { Runtime } from './context.js';
export async function approve(intents:OrderIntent[],market:Market,books:OrderBook[]) {
  const result=await runTool('risk','authorize',`risk-${intents[0].operationId}`,{operationIds:intents.map(i=>i.operationId),marketId:market.id,mode:intents[0].mode},async()=>({ok:true,data:await authorize(intents,market,books),source:'Deterministic risk policy',observedAt:new Date().toISOString(),freshUntil:new Date(Date.now()+15000).toISOString()}));
  return result.ok&&result.data?result.data:{approved:false,reason:result.error?.message??'Risk Guardian tidak tersedia'};
}
export async function execute(id:string,runtime:Runtime) {
  const order=(await pool.query('SELECT mode FROM orders WHERE id=$1',[id])).rows[0];
  if(!order) throw new Error('Order tidak ditemukan');
  return runTool('execution','execute',`execution-${id}`,{operationId:id,mode:order.mode},async()=>{await executeOrder(id,runtime);return {ok:true,data:{done:true},source:'Approved execution boundary',observedAt:new Date().toISOString(),freshUntil:new Date(Date.now()+15000).toISOString(),operationId:id};});
}
