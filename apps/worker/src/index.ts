import { Worker } from 'bullmq';
import { pool } from '../../../packages/db/src/index.js';
import { env } from '../../../packages/core/src/config.js';
import { logger } from '../../../packages/core/src/logger.js';
import { operationsQueue, researchQueue, discoveryQueue, queueConnection, redis } from '../../../packages/core/src/queue.js';
import { initialize, writeState, readState, readControl, readSettings, audit, agentState } from '../../../packages/core/src/state.js';
import { chargeService } from '../../../packages/core/src/ledger.js';
import { evaluate } from '../../../packages/core/src/evaluation.js';
import { createRuntime } from './context.js';
import { task, researchForecast, marketSignature } from './pipeline.js';
import { resumePaperOrders, cancelOpen, cancelOrder, replaceOrder } from './execution.js';
import { walletCheck, markPositions, manageSettlements, reconcileLive, recordEquity } from './portfolio.js';
import { manageExits, considerMarket } from './strategies.js';
import type { Market, Mode } from '../../../packages/shared/src/index.js';
import { startDiscovery, initializeDiscoverySchedule } from './discovery.js';
import { pruneBookSnapshots } from '../../../packages/core/src/book-replay.js';
import { recoverInterruptedOperations } from './recovery.js';
await initialize();
const lease = await pool.connect();
if (!(await lease.query('SELECT pg_try_advisory_lock(73050) acquired')).rows[0].acquired) { logger.error('Only one wallet worker may run'); await lease.release(); await pool.end(); process.exit(1); }
const runtime = await createRuntime();
await recoverInterruptedOperations();
await audit('supervisor','Worker dimulai','Database checkpoints dipulihkan; order live ambigu tidak dikirim ulang');
let shuttingDown = false, feedSignature = '', marketFeed: Awaited<ReturnType<typeof runtime.public.startMarketFeed>> | undefined, userFeed: Awaited<ReturnType<typeof runtime.public.startUserFeed>> | undefined;
let lastFeedMessage = 0, lastReconcile = 0, lastEval = 0, lastMark = 0, lastPrune=0;
async function installMarketFeed(markets: Market[]) {
  const signature = marketSignature(markets); if (!markets.length || (marketFeed && signature===feedSignature)) return;
  marketFeed?.close(); feedSignature=signature;
  const handle=await runtime.public.startMarketFeed(markets.flatMap(m=>[m.yesToken,m.noToken])); marketFeed=handle;
  void (async()=>{
    try { for await (const event of handle) {
      if(shuttingDown) break;
      const data = event as unknown as Record<string,unknown>;
      if (Date.now()-lastFeedMessage>1000) {lastFeedMessage=Date.now(); await writeState('market-feed',{connected:true,at:new Date().toISOString(),lastEvent:String(data.type ?? data.eventType ?? 'market')});}
      // REST books remain execution authority. A stream event never grants a risk permit.
    } } catch { await writeState('market-feed',{connected:false,at:new Date().toISOString()}); }
    finally { if(marketFeed===handle) {marketFeed=undefined;feedSignature='';} }
  })();
}
async function installUserFeed() {
  if(!runtime.live || userFeed || shuttingDown)return;
  const handle=await runtime.live.startUserFeed();userFeed=handle;
  await writeState('live-reconciliation',{ok:false,at:new Date().toISOString(),reason:'User stream connected; reconciliation required'});
  void (async()=>{try {for await (const _event of handle) {await writeState('live-reconciliation',{ok:false,at:new Date().toISOString(),reason:'User stream event; reconciliation required'});await operationsQueue.add('reconcile',{}, {jobId:`reconcile-${Math.floor(Date.now()/5000)}`,priority:1});}} catch {await writeState('live-reconciliation',{ok:false,at:new Date().toISOString(),reason:'User stream disconnected'});}finally{if(userFeed===handle)userFeed=undefined;}})();
}
let heartbeatBusy=false;
const heartbeatTimer=setInterval(()=>{
  void (async()=>{
    if(shuttingDown||heartbeatBusy) return;heartbeatBusy=true;
    try {
    await lease.query('SELECT 1');
    await writeState('worker-heartbeat',{at:new Date().toISOString(),pid:process.pid});
    if(runtime.live) {try {await runtime.live.orderHeartbeat();} catch {await writeState('live-reconciliation',{ok:false,at:new Date().toISOString(),reason:'Order heartbeat unavailable'});}}
    if(runtime.live&&!userFeed) await installUserFeed().catch(()=>writeState('live-reconciliation',{ok:false,at:new Date().toISOString(),reason:'User stream reconnect pending'}));
    if(lastFeedMessage && Date.now()-lastFeedMessage>30000) await writeState('market-feed',{connected:false,at:new Date().toISOString(),reason:'No recent market data'});
    }finally{heartbeatBusy=false;}
  })().catch(()=>{logger.error('Worker lease/database unavailable; shutting down to prevent untracked actions');void shutdown();});
},5000);
const operations=new Worker('polymarket-operations',async job=>{
  const jobId=String(job.id),control=await readControl(),mode=control.mode as Mode;
  if(job.name==='wallet-check') return task('supervisor','monitor',jobId,{},()=>walletCheck(runtime));
  if(job.name==='refresh-trends') return discoveryQueue.add('trends',{}, {jobId:`manual-trends-${jobId}`});
  if(job.name==='cancel-open') return task('execution','cancel',jobId,job.data,async()=>{await cancelOpen(job.data.mode,runtime);return {done:true};});
  if(job.name==='cancel-order') return task('execution','cancel',jobId,job.data,async()=>{await cancelOrder(job.data.id,runtime);return {done:true};});
  if(job.name==='replace-order') return task('execution','cancel',jobId,job.data,async()=>{await replaceOrder(job.data.id,job.data.price,job.data.shares,runtime);return {done:true};});
  if(job.name==='consider') {if(control.state!=='running')return;const market=await runtime.public.getMarket(job.data.marketId);const [yes,no]=await Promise.all([runtime.public.getBook(market.yesToken),runtime.public.getBook(market.noToken)]);return task('strategy','propose',jobId,{marketId:market.id},()=>considerMarket(market,yes,no,runtime));}
  if(job.name==='reconcile') {if(runtime.live) await task('portfolio','reconcile',jobId,{},async()=>{await reconcileLive(runtime);return {done:true};});return;}
  if(job.name!=='pulse') throw new Error('Unknown operation job');
  await task('supervisor','monitor',jobId,{},async()=>({mode,control:control.state,redis:await redis.ping(),workerAt:new Date().toISOString()}));
  if(mode==='paper') await task('execution','reconcile',jobId,{},async()=>{await resumePaperOrders(runtime);return {done:true};});
  if(runtime.live && Date.now()-lastReconcile>10000) {await task('portfolio','reconcile',jobId,{},async()=>{await reconcileLive(runtime);return {done:true};});lastReconcile=Date.now();}
  if(Date.now()-lastMark>15000) {
    await task('portfolio','mark',jobId,{mode},async()=>{await markPositions(mode,runtime);await manageSettlements(mode,runtime);await manageExits(mode,runtime);return recordEquity(mode);});lastMark=Date.now();
  }
  if(!marketFeed) {const rows=(await pool.query('SELECT payload FROM markets ORDER BY updated_at DESC LIMIT 40')).rows;await installMarketFeed(rows.map(r=>r.payload));}
  if(Date.now()-lastEval>60000) {
    await task('evaluation','evaluate',jobId,{},async()=>{const{settings}=await readSettings();return evaluate(settings);});lastEval=Date.now();
    const {settings}=await readSettings();await chargeService(`infrastructure:${mode}:${new Date().toISOString().slice(0,10)}`,mode,settings.infrastructureDailyCostUsd,settings.serviceCostConversion,'Biaya infrastruktur harian dikonfigurasi');
    const wallet=await readState<{checkedAt:string}>('wallet');if(!wallet||Date.now()-Date.parse(wallet.checkedAt)>60000) await walletCheck(runtime);
    if(Date.now()-lastPrune>3600000){await pruneBookSnapshots();lastPrune=Date.now();}
  }
},{connection:queueConnection,concurrency:1,lockDuration:300000,maxStalledCount:1});
const researchers=new Worker('polymarket-research',async job=>{
  if(job.name==='health')return {ok:true};
  if(job.name!=='research')throw new Error('Unknown research job');
  await researchForecast(job.data.marketId,job.data.mode,runtime,String(job.id));
},{connection:queueConnection,concurrency:1,lockDuration:300000,maxStalledCount:0});
const discovery=startDiscovery(runtime,installMarketFeed);
for(const worker of [operations,researchers,discovery]) {
  worker.on('failed',(job,error)=>{logger.error({job:job?.name,errorName:error.name},'Durable job failed');void writeState(`queue-health:${worker.name}`,{ok:false,at:new Date().toISOString(),pid:process.pid,reason:'Job failed; inspect tool audit'});void audit('supervisor','Pekerjaan tertunda',`${job?.name ?? 'unknown'} gagal; lihat hasil tool dan status koneksi`,'warning');});
  worker.on('error',error=>{logger.error({errorName:error.name,reason:error.message.slice(0,500)},'Queue error');void writeState(`queue-health:${worker.name}`,{ok:false,at:new Date().toISOString(),pid:process.pid,reason:error.message.slice(0,200)});});
  worker.on('completed',()=>{void writeState(`queue-health:${worker.name}`,{ok:true,at:new Date().toISOString(),pid:process.pid});});
}
await Promise.all([operations.waitUntilReady(),researchers.waitUntilReady(),discovery.waitUntilReady()]);
await operationsQueue.upsertJobScheduler('operations-pulse',{every:5000},{name:'pulse',data:{},opts:{priority:2,removeOnComplete:100,removeOnFail:100}});
await initializeDiscoverySchedule();
await researchQueue.add('health',{}, {jobId:`research-health-${process.pid}-${Date.now()}`,removeOnComplete:10});
await writeState('worker-heartbeat',{at:new Date().toISOString(),pid:process.pid});
await agentState('risk',{status:'waiting',reason:'Menunggu usulan; semua entry membutuhkan persetujuan deterministik'});
await agentState('research',{status:'waiting',reason:env.TAVILY_API_KEY?'Menunggu pasar dan anggaran':'Tavily API key belum dikonfigurasi'});
await agentState('forecast',{status:'waiting',reason:'Menunggu bukti terverifikasi dan penugasan model'});
logger.info('Worker ready; paper and live controls loaded from database');
async function shutdown(){
  if(shuttingDown)return;shuttingDown=true;clearInterval(heartbeatTimer);marketFeed?.close();userFeed?.close();
  await writeState('worker-heartbeat',{at:new Date(0).toISOString()}).catch(()=>undefined);
  await Promise.allSettled([operations.close(),researchers.close(),discovery.close()]);await operationsQueue.close();await researchQueue.close();await discoveryQueue.close();await redis.quit();lease.release();await pool.end();process.exit(0);
}
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>void shutdown());
