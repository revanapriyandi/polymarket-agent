import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../../packages/db/src/index.js';
import { researchQueue, operationsQueue, discoveryQueue, signalsQueue } from '../../../packages/core/src/queue.js';
import { researchReady } from '../../../packages/core/src/ai-service.js';
import { readControl, readSettings, audit } from '../../../packages/core/src/state.js';
import { redactSecrets } from '../../../packages/ai/src/security.js';
import { storedMarket } from './markets.js';
import { HttpError, stepUp } from './security.js';
import { roles, type Mode } from '../../../packages/shared/src/index.js';

export async function registerResearch(app: FastifyInstance) {
  app.get('/api/research/:id', async req => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const [market, control, {settings}] = await Promise.all([storedMarket(id),readControl(),readSettings()]);
    const [evidence, forecasts, runs, ready] = await Promise.all([
      pool.query('SELECT id,payload,created_at FROM evidence WHERE market_id=$1 ORDER BY created_at DESC LIMIT 60',[id]),
      pool.query(`SELECT f.id,f.payload,f.baseline,f.outcome,f.provider_version,f.rules_hash,f.created_at,p.config->>'name' provider,
        coalesce((SELECT i.model FROM invocations i WHERE i.provider_id=f.provider_id AND i.provider_version=f.provider_version AND i.role='forecast' AND i.status='complete' AND i.created_at<=f.created_at ORDER BY i.created_at DESC LIMIT 1),
          CASE WHEN p.version=f.provider_version THEN p.config->>'model' END,'Tidak tercatat') model
        FROM forecasts f LEFT JOIN providers p ON p.id=f.provider_id WHERE market_id=$1 ORDER BY f.created_at DESC LIMIT 30`,[id]),
      pool.query("SELECT id,job_id,role,tool,skill_version,result,duration_ms,created_at FROM tool_runs WHERE input->>'marketId'=$1 AND role IN ('research','forecast') ORDER BY created_at DESC LIMIT 60",[id]),
      researchReady(control.mode as Mode)
    ]);
    const reasons=[];
    if(!ready)reasons.push('Konfigurasikan dan uji model research, evidence, dan forecast.');
    if(!settings.strategyEnabled.prediction)reasons.push('Strategi prediksi belum diaktifkan.');
    if(Number(settings.researchDailyBudgetUsd)<=0||Number(settings.researchMonthlyBudgetUsd)<=0)reasons.push('Isi anggaran riset harian dan bulanan.');
    if(control.state!=='running')reasons.push('Operasi sedang dijeda.');
    return {market,evidence:evidence.rows,forecasts:forecasts.rows,runs:redactSecrets(runs.rows),canRequest:reasons.length===0,reasons,mode:control.mode};
  });
  app.post('/api/research/:id',async req=>{
    await stepUp(req);
    const {id}=z.object({id:z.string().regex(/^\d+$/)}).parse(req.params);
    const [market,control,{settings}]=await Promise.all([storedMarket(id),readControl(),readSettings()]);
    if(control.state!=='running'||!settings.strategyEnabled.prediction||!await researchReady(control.mode as Mode)||Number(settings.researchDailyBudgetUsd)<=0||Number(settings.researchMonthlyBudgetUsd)<=0)throw new HttpError(409,'Model, budget, strategi prediksi, dan operasi harus siap sebelum meminta riset');
    if(!market.acceptingOrders||market.closed||Date.parse(market.endDate)<=Date.now()+86400000)throw new HttpError(409,'Pasar berada di luar horizon riset strategi');
    const job=await researchQueue.add('research',{marketId:id,mode:control.mode},{jobId:`manual-research-${control.mode}-${id}-${Math.floor(Date.now()/1800000)}`});
    await audit('owner','Riset pasar diminta',market.question,'info',String(job.id));
    return {queued:true,jobId:job.id,message:'Riset diantrikan; budget dan sumber diperiksa kembali oleh worker.'};
  });
  app.get('/api/agents/:role/runs',async req=>{
    const {role}=z.object({role:z.enum(roles)}).parse(req.params);
    const rows=await pool.query('SELECT id,job_id,tool,skill_version,result,duration_ms,created_at FROM tool_runs WHERE role=$1 ORDER BY created_at DESC LIMIT 30',[role]);
    return redactSecrets(rows.rows);
  });
  app.get('/api/queues',async()=>{
    const queues=[operationsQueue,discoveryQueue,researchQueue,signalsQueue];
    return Promise.all(queues.map(async queue=>({name:queue.name,...await queue.getJobCounts('active','waiting','delayed','failed')})));
  });
}
