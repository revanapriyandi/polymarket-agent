import type { FastifyInstance } from 'fastify';
import { lossLimitReason } from '../../../packages/core/src/risk-limits.js';
import { z } from 'zod';
import { db, pool, schema, transaction } from '../../../packages/db/src/index.js';
import { SettingsSchema, ProviderConfigSchema, ProviderSecretsSchema, AssignmentSchema, type Mode } from '../../../packages/shared/src/index.js';
import { readSettings, readControl, readState, audit } from '../../../packages/core/src/state.js';
import { dashboard } from '../../../packages/core/src/dashboard.js';
import { providerViews, provider, probe, models, encryptSecret } from '../../../packages/core/src/ai-service.js';
import { postJournal, d, metrics } from '../../../packages/core/src/ledger.js';
import { operationsQueue } from '../../../packages/core/src/queue.js';
import { env } from '../../../packages/core/src/config.js';
import { evaluate } from '../../../packages/core/src/evaluation.js';
import { PolymarketGateway } from '../../../packages/trading/src/index.js';
import { skills } from '../../../packages/agents/src/index.js';
import { HttpError, stepUp, reauthenticate } from './security.js';
import { registerTables } from './tables.js';
import { registerEvaluation } from './evaluation.js';
import { registerBookReplay } from './book-replay.js';
const gateway = new PolymarketGateway();
const idOf = (v: unknown) => z.object({ id: z.string().min(1).max(200) }).parse(v).id;
export async function registerRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', () => dashboard());
  app.get('/api/skills', () => skills);
  app.get('/api/settings', async () => ({ ...await readSettings(), assignments: await db.select().from(schema.assignments) }));
  app.post('/api/security/reauth', async req => reauthenticate(req, z.object({ password: z.string().min(1).max(128) }).parse(req.body).password));
  app.put('/api/settings', async req => {
    await stepUp(req);
    const input = z.object({ settings: SettingsSchema, expectedVersion: z.number().int() }).parse(req.body);
    await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(73011)');
      const current = (await client.query('SELECT * FROM settings WHERE id=1 FOR UPDATE')).rows[0];
      if (current.version !== input.expectedVersion) throw new HttpError(409, 'Konfigurasi berubah; muat ulang sebelum menyimpan');
      const delta = d(input.settings.paper.capital).minus(current.payload.paper.capital);
      if (!delta.eq(0)) {
        const m = await metrics('paper', current.payload, client);
        if (d(m.available).plus(delta).lt(0)) throw new HttpError(409, 'Modal paper tidak dapat dikurangi melebihi dana tersedia');
        await postJournal(client, `paper-capital-v${current.version+1}`, 'paper', delta.gt(0) ? 'deposit' : 'withdrawal', 'Perubahan modal virtual oleh pemilik', [{ account: 'cash', amount: delta.toFixed() }, { account: 'capital', amount: delta.negated().toFixed() }]);
      }
      await client.query('UPDATE settings SET payload=$1,version=version+1,updated_at=now() WHERE id=1', [JSON.stringify(input.settings)]);
    });
    await audit('owner', 'Pengaturan diubah', 'Versi kebijakan baru; usulan lama harus dievaluasi ulang');
    return readSettings();
  });
  app.get('/api/providers', () => providerViews());
  app.post('/api/providers', async req => {
    await stepUp(req);
    const input = z.object({ config: ProviderConfigSchema, secrets: ProviderSecretsSchema }).parse(req.body);
    const [row] = await db.insert(schema.providers).values({ config: input.config, secrets: encryptSecret(JSON.stringify(input.secrets)) }).returning({ id: schema.providers.id });
    await audit('owner', 'Koneksi AI ditambahkan', input.config.name);
    return { id: row.id };
  });
  app.put('/api/providers/:id', async req => {
    await stepUp(req); const id = z.string().uuid().parse(idOf(req.params));
    const input = z.object({ config: ProviderConfigSchema, secrets: ProviderSecretsSchema.optional(), expectedVersion: z.number().int() }).parse(req.body);
    const p = await provider(id);
    if (p.version !== input.expectedVersion) throw new HttpError(409, 'Versi provider berubah');
    const changed = await pool.query('UPDATE providers SET config=$1,secrets=$2,version=version+1,capabilities=NULL,updated_at=now() WHERE id=$3 AND version=$4 RETURNING id', [JSON.stringify(input.config), input.secrets ? encryptSecret(JSON.stringify(input.secrets)) : p.secrets, id, p.version]);
    if (!changed.rowCount) throw new HttpError(409, 'Versi provider berubah');
    await audit('owner', 'Koneksi AI diubah', `${input.config.name}; kemampuan dan profil harus diuji ulang`); return { ok: true };
  });
  app.delete('/api/providers/:id', async req => {
    await stepUp(req); const id = z.string().uuid().parse(idOf(req.params));
    await transaction(async client=>{
      const found=await client.query('SELECT id FROM providers WHERE id=$1 FOR UPDATE',[id]);
      if(!found.rowCount)throw new HttpError(404,'Provider tidak ditemukan');
      const used=await client.query('SELECT role FROM assignments WHERE primary_id=$1 OR fallback_ids @> $2::jsonb',[id,JSON.stringify([id])]);
      if(used.rowCount)throw new HttpError(409,'Lepaskan koneksi dari seluruh peran terlebih dahulu');
      await client.query("UPDATE providers SET config=jsonb_set(config,'{enabled}','false'),version=version+1,capabilities=NULL,updated_at=now() WHERE id=$1",[id]);
    });
    await audit('owner', 'Koneksi AI dinonaktifkan', 'Riwayat biaya dan forecast tetap tersimpan'); return { ok: true };
  });
  app.post('/api/providers/:id/probe', async req => { await stepUp(req); return probe(z.string().uuid().parse(idOf(req.params))); });
  app.get('/api/providers/:id/models', async req => models(z.string().uuid().parse(idOf(req.params))));
  app.put('/api/assignments', async req => {
    await stepUp(req); const input = AssignmentSchema.parse(req.body);
    if (input.fallbackIds.includes(input.primaryId) || new Set(input.fallbackIds).size !== input.fallbackIds.length) throw new HttpError(400, 'Fallback tidak boleh berulang');
    if(!input.fallbackEnabled && input.fallbackIds.length)throw new HttpError(400,'Fallback IDs harus kosong saat fallback dinonaktifkan');
    await transaction(async client=>{
      for(const id of [input.primaryId,...input.fallbackIds].sort()){
        const p=(await client.query('SELECT config,capabilities FROM providers WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(!p)throw new HttpError(404,'Provider tidak ditemukan');
        if(!p.config.enabled||!p.capabilities?.text||!p.capabilities.structured||!p.capabilities.usage||(input.role==='research'&&!p.capabilities.tools)||!Number.isFinite(Date.parse(p.capabilities.testedAt))||Date.now()-Date.parse(p.capabilities.testedAt)>30*86400000)throw new HttpError(400,'Provider harus aktif dan lulus kemampuan peran dalam 30 hari terakhir');
      }
      await client.query('INSERT INTO assignments(role,primary_id,fallback_enabled,fallback_ids) VALUES($1,$2,$3,$4) ON CONFLICT(role) DO UPDATE SET primary_id=excluded.primary_id,fallback_enabled=excluded.fallback_enabled,fallback_ids=excluded.fallback_ids',[input.role,input.primaryId,input.fallbackEnabled,JSON.stringify(input.fallbackIds)]);
    });
    await audit('owner', 'Penugasan model diubah', `${input.role}; fallback ${input.fallbackEnabled ? 'diizinkan eksplisit' : 'dinonaktifkan'}`); return { ok: true };
  });
  app.get('/api/wallet', async () => ({ walletAddress: (await readSettings()).settings.walletAddress, status: await readState('wallet'), signerConfigured: !!env.POLYMARKET_PRIVATE_KEY, rpcConfigured: !!env.POLYGON_RPC_URL, relayerConfigured: !!env.POLYMARKET_RELAYER_API_KEY }));
  app.post('/api/wallet/check', async req => { await stepUp(req); const job = await operationsQueue.add('wallet-check', {}, { priority: 1 }); return { queued: true, jobId: job.id }; });
  app.get('/api/market/:id/history', async req => { const market = await gateway.getMarket(idOf(req.params)); return gateway.getHistory(market.yesToken); });
  app.post('/api/control', async req => {
    await stepUp(req);
    const { action } = z.object({ action: z.enum(['pause','resume','emergency','paper','activate-live']) }).parse(req.body);
    const control = await readControl(), { settings } = await readSettings();
    if (action === 'activate-live') {
      const gates = await evaluate(settings), enabled = (['arbitrage','prediction'] as const).filter(strategy => settings.strategyEnabled[strategy]);
      const wallet = await readState<{ ready: boolean; checkedAt: string }>('wallet');
      const recon = await readState<{ ok: boolean; at: string }>('live-reconciliation');
      if (!enabled.length || enabled.some(strategy => !gates.some(gate => gate.strategy===strategy && gate.eligible)) || !settings.live || !settings.liveRiskAcknowledged || env.ENABLE_LIVE_EXECUTION !== 'true' || !wallet?.ready || Date.now() - Date.parse(wallet.checkedAt) > 60000 || !recon?.ok || Date.now() - Date.parse(recon.at)>30000) throw new HttpError(409, 'Live belum memenuhi evaluasi, modal, wallet, rekonsiliasi, dan konfigurasi server');
      await pool.query("UPDATE controls SET mode='live',state='running',reason='Aktivasi eksplisit pemilik',updated_at=now() WHERE id=1");
    } else if (action === 'paper') {
      if (control.mode === 'live') {
        const active = await pool.query("SELECT id FROM orders WHERE mode='live' AND status NOT IN ('filled','cancelled','rejected','expired') UNION SELECT id::text FROM positions WHERE mode='live' AND shares>0");
        if (active.rowCount) throw new HttpError(409, 'Selesaikan atau batalkan exposure live sebelum beralih mode');
      }
      await pool.query("UPDATE controls SET mode='paper',state='paused',reason='Mode paper dipilih',updated_at=now() WHERE id=1");
    } else {
      if (action === 'resume') {
        const m = await metrics(control.mode as Mode, settings), limits = control.mode === 'paper' ? settings.paper : settings.live;
        if (!limits || m.equity === null || m.totalPnl === null || lossLimitReason(m, limits)) throw new HttpError(409, 'Valuasi belum pasti atau batas kerugian tercapai; rekonsiliasi diperlukan sebelum resume');
      }
      await pool.query('UPDATE controls SET state=$1,reason=$2,updated_at=now() WHERE id=1', [action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'emergency', `Tindakan pemilik: ${action}`]);
      if (action === 'emergency' || action === 'pause') await operationsQueue.add('cancel-open', { mode: control.mode }, { priority: 1 });
    }
    await audit('owner', 'Kontrol operasi', action, action === 'emergency' ? 'warning' : 'info'); return readControl();
  });
  async function actionableOrder(id:string){
    const order=(await pool.query('SELECT status,mode FROM orders WHERE id=$1',[id])).rows[0];
    if(!order)throw new HttpError(404,'Order tidak ditemukan');
    if(!['approved','preparing','open','partial'].includes(order.status))throw new HttpError(409,'Status order tidak mengizinkan aksi ini');
    if(order.mode!==(await readControl()).mode)throw new HttpError(409,'Order bukan pada mode operasi aktif');
  }
  app.post('/api/orders/:id/cancel',async req=>{
    await stepUp(req);const id=idOf(req.params);await actionableOrder(id);await operationsQueue.add('cancel-order',{id},{priority:1});return {queued:true};
  });
  app.post('/api/orders/:id/replace',async req=>{
    await stepUp(req);const input=z.object({price:z.string().regex(/^0\.\d{1,8}$/).refine(v=>d(v).gt(0)&&d(v).lt(1),'Harga harus lebih dari 0 dan kurang dari 1'),shares:z.string().max(39).regex(/^\d{1,30}(\.\d{1,8})?$/).refine(v=>d(v).gt(0),'Shares harus positif')}).parse(req.body);
    const id=idOf(req.params);await actionableOrder(id);await operationsQueue.add('replace-order',{id,...input},{priority:1});return {queued:true};
  });
  await registerTables(app);
  await registerEvaluation(app);
  await registerBookReplay(app);
}
