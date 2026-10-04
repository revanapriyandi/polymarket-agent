import { createHash } from 'node:crypto';
import { recordBookSnapshot } from '../../../packages/core/src/book-replay.js';
import { eq } from 'drizzle-orm';
import { pool, db, schema } from '../../../packages/db/src/index.js';
import { agentState, readSettings, readControl, readState, writeState, audit } from '../../../packages/core/src/state.js';
import { forecast, analyze, planResearch, researchReady } from '../../../packages/core/src/ai-service.js';
import { profileVersion, selectedForecastProfiles } from '../../../packages/core/src/profiles.js';
import { researchQueue, operationsQueue } from '../../../packages/core/src/queue.js';
import { runTool, researchMarket } from '../../../packages/agents/src/index.js';
import { validateToolResult } from '../../../packages/agents/src/registry.js';
import { readServiceConfig } from '../../../packages/services/src/settings.js';
import type { AgentRole, ToolResult, Market, Mode } from '../../../packages/shared/src/index.js';
import type { Runtime } from './context.js';
export async function task<T>(role: AgentRole, tool: string, jobId: string, input: Record<string, unknown>, action: () => Promise<T>, freshSeconds = 30): Promise<T | null> {
  const started = Date.now();
  await agentState(role, { status: 'running', lastRunAt: new Date().toISOString(), lastTool: tool, reason: `Menjalankan ${tool}` });
  const result = await runTool<T>(role, tool, jobId, input, async () => {
    const data = await action();
    return { ok: true, data, source: tool === 'discover' || tool === 'getbook' ? 'Polymarket official API' : 'Polymarket Agent runtime', observedAt: new Date().toISOString(), freshUntil: new Date(Date.now()+freshSeconds*1000).toISOString(), operationId: `${jobId}:${tool}` } satisfies ToolResult<T>;
  });
  await agentState(role, { status: result.ok ? 'waiting' : 'degraded', durationMs: Date.now()-started, reason: result.ok ? 'Selesai; menunggu pekerjaan berikutnya' : result.error?.message ?? 'Tool gagal' });
  return result.ok ? result.data ?? null : null;
}
/** Completed paid stages survive worker restart; stale/uncertain work is never charged again in this job. */
async function paidStage<T>(role: AgentRole, tool: string, jobId: string, input: Record<string, unknown>, action: () => Promise<T>): Promise<T | null> {
  const id = `research-stage:${jobId}:${tool}`;
  const inputHash = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
  const checkpoint = (await pool.query('SELECT result FROM checkpoints WHERE id=$1',[id])).rows[0];
  if (checkpoint && checkpoint.result.inputHash!==inputHash) return null;
  const completed = checkpoint?.result.result ?? (await pool.query("SELECT result FROM tool_runs WHERE job_id=$1 AND role=$2 AND tool=$3 AND input=$4::jsonb",[jobId,role,tool,JSON.stringify(input)])).rows[0]?.result;
  if (completed) {
    const result = validateToolResult(role,tool,completed);
    if (!result.ok || Date.parse(result.observedAt)>Date.now()+1000 || Date.parse(result.freshUntil)<=Date.now() || Date.parse(result.freshUntil)>Date.parse(result.observedAt)+3600000) return null;
    return result.data as T;
  }
  return task(role,tool,jobId,input,async()=>{
    const value = await action(), now = new Date().toISOString();
    const result = validateToolResult(role,tool,{ok:true,data:value,source:'Polymarket Agent runtime',observedAt:now,freshUntil:new Date(Date.now()+3600000).toISOString()});
    await pool.query("INSERT INTO checkpoints(id,stage,result) VALUES($1,'paid-stage',$2) ON CONFLICT DO NOTHING",[id,JSON.stringify({inputHash,result})]);
    return value;
  },3600);
}
export async function scan(runtime: Runtime, jobId: string) {
  const { settings } = await readSettings(), control = await readControl();
  const last = await readState<{ at: string }>('last-scan');
  if (last && Date.now()-Date.parse(last.at)<settings.scanIntervalSeconds*1000) return;
  const markets = await task('scanner','discover',jobId,{ limit: settings.maxMarkets },() => runtime.public.discoverMarkets(settings.maxMarkets));
  if (!markets) return;
  const permittedProfiles = await Promise.all((await selectedForecastProfiles()).map(async model => ({ ...model, profileVersion: await profileVersion('prediction', settings, model) })));
  const researchProfile = createHash('sha256').update(JSON.stringify(permittedProfiles)).digest('hex').slice(0, 16);
  let queued = 0;
  for (const market of markets) {
    const [old] = await db.select().from(schema.markets).where(eq(schema.markets.id,market.id));
    if (old && old.rulesHash !== market.rulesHash) await audit('research','Aturan resolution berubah',market.question,'warning');
    await db.insert(schema.markets).values({id:market.id,payload:market,rulesHash:market.rulesHash}).onConflictDoUpdate({target:schema.markets.id,set:{payload:market,rulesHash:market.rulesHash,updatedAt:new Date()}});
    try {
      const books = await task('scanner','getbook',`${jobId}-${market.id}`,{marketId:market.id},async()=>Promise.all([runtime.public.getBook(market.yesToken),runtime.public.getBook(market.noToken)]));
      if (!books) continue;
      await recordBookSnapshot(market,books[0],books[1]);
      for (const book of books) await db.insert(schema.books).values({tokenId:book.tokenId,payload:book}).onConflictDoUpdate({target:schema.books.tokenId,set:{payload:book,updatedAt:new Date()}});
      const midpoint = (Number(books[0].bids[0]?.price) + Number(books[0].asks[0]?.price)) / 2;
      const priceChangeThreshold = (control.mode === 'live' ? settings.live : settings.paper)?.minimumEdge ?? settings.paper.minimumEdge;
      if (Number.isFinite(midpoint)) await pool.query("UPDATE forecasts SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb(now()::text)) WHERE market_id=$1 AND (payload->>'expiresAt')::timestamptz>now() AND (rules_hash<>$2 OR abs(baseline-$3::numeric)>=$4::numeric)", [market.id, market.rulesHash, midpoint, priceChangeThreshold]);
      if ((await readControl()).state === 'running') {
        const bookVersion = createHash('sha256').update(`${market.rulesHash}:${books[0].hash}:${books[1].hash}`).digest('hex').slice(0, 16);
        await operationsQueue.add('consider', { marketId: market.id }, { jobId: `consider-${market.id}-${bookVersion}` });
        queued++;
      }
      if (settings.strategyEnabled.prediction && control.state === 'running' && permittedProfiles.length && researchable(market)) {
        const fresh = await pool.query("SELECT f.id FROM forecasts f WHERE market_id=$1 AND rules_hash=$2 AND (payload->>'expiresAt')::timestamptz>now() AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS p(\"providerId\" uuid,\"providerVersion\" integer,\"profileVersion\" text) WHERE f.provider_id=p.\"providerId\" AND f.provider_version=p.\"providerVersion\" AND f.profile_version=p.\"profileVersion\") LIMIT 1",[market.id,market.rulesHash,JSON.stringify(permittedProfiles)]);
        if (!fresh.rowCount) await researchQueue.add('research',{marketId:market.id,mode:control.mode},{jobId:`research-${market.id}-${Math.floor(Date.now()/1800000)}-${market.rulesHash.slice(0,8)}-${researchProfile}`});
      }
    } catch { await audit('scanner','Pasar dilewati',`${market.question}: book/data tidak tersedia atau berubah`,'warning'); }
  }
  await writeState('last-scan',{at:new Date().toISOString(),count:markets.length});
  await agentState('strategy',{status:'waiting',reason:queued?`${queued} pasar diteruskan untuk pemeriksaan strategi`:'Menunggu edge positif setelah biaya; tidak memaksakan transaksi'});
  await audit('scanner','Pemindaian pasar selesai',`${markets.length} pasar standar; ${queued} pasar diteruskan`);
  return markets;
}
function researchable(market: Market): boolean {
  const cutoff = Date.parse(market.endDate);
  return market.active && !market.closed && !market.resolved && market.acceptingOrders && !market.negRisk && Number.isFinite(cutoff) && cutoff > Date.now() + 86400000 && cutoff <= Date.now() + 30 * 86400000;
}
export async function researchForecast(marketId: string, mode: Mode, runtime: Runtime, jobId: string) {
  const {settings,version:policyVersion} = await readSettings(), control = await readControl();
  if(control.state!=='running' || control.mode!==mode || !settings.strategyEnabled.prediction) return;
  if (!await researchReady(mode)) { await agentState('forecast',{status:'waiting',reason:'Pilih dan uji model research, evidence, dan forecast sebelum riset berbayar'}); return; }
  const servicesVersion = (await readServiceConfig()).version, capturedProfile = await profileVersion('prediction',settings);
  const current = await runtime.public.getMarket(marketId);
  if (!researchable(current)) return;
  const beforePaidCall = async () => {
    const latest = await runtime.public.getMarket(marketId), state = await readControl(), latestSettings = await readSettings();
    if (!researchable(latest) || latest.rulesHash !== current.rulesHash || state.state !== 'running' || state.mode !== mode || !latestSettings.settings.strategyEnabled.prediction || latestSettings.version!==policyVersion || (await readServiceConfig()).version!==servicesVersion || await profileVersion('prediction',latestSettings.settings)!==capturedProfile) throw new Error('Market or research policy changed before paid call');
  };
  await db.update(schema.markets).set({payload:current,rulesHash:current.rulesHash,updatedAt:new Date()}).where(eq(schema.markets.id,marketId));
  const boundInput = {marketId,mode,rulesHash:current.rulesHash,policyVersion,servicesVersion,profileVersion:capturedProfile};
  const initial = await paidStage('research','search',jobId,boundInput,async()=>{ await beforePaidCall(); return researchMarket(current,mode); });
  if (!initial) return;
  const plan = await paidStage('research','plan',jobId,boundInput,()=>planResearch(current,initial,mode,beforePaidCall));
  if (!plan) return;
  if (plan.action === 'abstain') { await agentState('research',{status:'waiting',reason:'Model riset memilih abstain; aturan atau bukti belum cukup'}); return; }
  const additional = await paidStage('research','searchMarketEvidence',jobId,{...boundInput,query:plan.query},async()=>{ await beforePaidCall(); return researchMarket(current,mode,plan.query); });
  if (!additional) return;
  const evidence = [...new Map([...additional,...initial].map(source=>[source.hash,source])).values()].filter(source=>{const retrieved=Date.parse(source.retrievedAt),published=source.publishedAt?Date.parse(source.publishedAt):retrieved;return Number.isFinite(retrieved)&&Number.isFinite(published)&&retrieved<=Date.now()+60000&&published<=Date.now()+60000&&Date.now()-retrieved<=86400000&&Date.now()-published<=86400000;}).slice(0,20);
  if (!evidence?.length || evidence.every((item:{content:string})=>item.content.startsWith('[RSS EXCERPT ONLY:'))) { await agentState('forecast',{status:'waiting',reason:'Menunggu teks sumber terverifikasi; cuplikan RSS saja tidak cukup untuk forecast'}); return; }
  const analyzedInput = {...boundInput,evidenceHash:createHash('sha256').update(evidence.map(source=>source.hash).sort().join(':')).digest('hex')};
  const researched = await paidStage('research','verifyrules',jobId,analyzedInput,()=>analyze('research',current,evidence,mode,beforePaidCall));
  if(!researched?.sufficient) {await agentState('research',{status:'waiting',reason:'Riset atau aturan resolution belum cukup jelas'});return;}
  const verified = await paidStage('research','evidence',jobId,analyzedInput,()=>analyze('evidence',current,evidence,mode,beforePaidCall));
  if(!verified?.sufficient) { await agentState('forecast',{status:'waiting',reason:'Pemeriksaan bukti belum cukup; forecast ditunda'}); return; }
  const existing = await pool.query('SELECT result FROM checkpoints WHERE id=$1',[`forecast:${jobId}`]);
  const result = await paidStage('forecast','forecast',jobId,analyzedInput,()=>forecast(current,evidence,mode,beforePaidCall));
  if(!result) return;
  if (Date.parse(result.forecast.expiresAt)<=Date.now()) return;
  const revalidated=await runtime.public.getMarket(marketId);
  if (!researchable(revalidated) || revalidated.rulesHash !== current.rulesHash) return;
  const book = await runtime.public.getBook(current.yesToken), bestBid=Number(book.bids[0]?.price),bestAsk=Number(book.asks[0]?.price);
  if(!Number.isFinite(bestBid)||!Number.isFinite(bestAsk)) return;
  const profile = result.signalProfileVersion ?? await profileVersion('prediction',settings);
  if (!existing.rowCount) {
    await beforePaidCall();
    await db.transaction(async tx=>{
      await tx.insert(schema.forecasts).values({marketId,providerId:result.providerId,providerVersion:result.providerVersion,profileVersion:profile,rulesHash:current.rulesHash,payload:result.forecast,baseline:String((bestBid+bestAsk)/2)});
      await tx.insert(schema.checkpoints).values({id:`forecast:${jobId}`,stage:'forecast',result:{profileVersion:profile,abstain:result.forecast.abstain}}).onConflictDoNothing();
    });
    await audit('forecast',result.forecast.abstain?'Forecast memilih menunggu':'Forecast tersimpan sebelum hasil diketahui',result.forecast.reason);
    await operationsQueue.add('consider',{marketId:current.id});
  }
  const assignedSummary = (await db.select().from(schema.assignments).where(eq(schema.assignments.role,'summary')))[0];
  if (assignedSummary) {
    try {
      const summary = await paidStage('research','summary',jobId,analyzedInput,()=>analyze('summary',current,evidence,mode,beforePaidCall,result.forecast));
      if (summary) await audit('research','Ringkasan forecast tersedia',summary.summary);
    } catch { await audit('research','Ringkasan forecast tidak tersedia','Forecast tervalidasi tetap tersimpan; tahap ringkasan gagal atau anggaran tidak tersedia','warning'); }
  }
}
export async function resolveForecasts(runtime: Runtime) {
  const cursor = await readState<{ marketId: string }>('resolution-cursor');
  const rows = (await pool.query("SELECT DISTINCT f.market_id FROM forecasts f JOIN markets m ON m.id=f.market_id WHERE f.outcome IS NULL AND (m.payload->>'endDate')::timestamptz < now() AND f.market_id>$1 ORDER BY f.market_id LIMIT 5", [cursor?.marketId ?? ''])).rows;
  const outcomes = await Promise.allSettled(rows.map(async row => {
    const resolution = await runtime.public.getResolution(row.market_id);
    if (resolution.resolved && resolution.outcomePrices[0] !== null && resolution.outcomePrices[0] !== undefined) await pool.query('UPDATE forecasts SET outcome=$1,resolved_at=now() WHERE market_id=$2 AND outcome IS NULL',[resolution.outcomePrices[0],row.market_id]);
  }));
  await writeState('resolution-cursor', { marketId: rows.at(-1)?.market_id ?? '', checkedAt: new Date().toISOString() });
  const failed = outcomes.filter(outcome => outcome.status === 'rejected').length;
  if (failed) await audit('evaluation', 'Resolution belum tersedia', `${failed}/${rows.length} pasar gagal diperiksa; dicoba lagi pada siklus discovery berikutnya`, 'warning');
}
export function marketSignature(markets: Market[]) { return createHash('sha256').update(markets.flatMap(m=>[m.yesToken,m.noToken]).sort().join(',')).digest('hex'); }
