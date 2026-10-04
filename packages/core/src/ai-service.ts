import { and, eq } from 'drizzle-orm';
import { db, pool, schema, transaction } from '../../db/src/index.js';
import { decryptSecret, encryptSecret, discoverModels, runCapabilityProbe, runForecast, runEvidenceAnalysis, runResearchPlan, estimateInputTokenUpperBound, type Usage } from '../../ai/src/index.js';
import { ProviderSecretsSchema, type Capabilities, type ProviderView, type Mode, type Market, type Evidence, type Forecast } from '../../shared/src/index.js';
import { d, postJournal } from './ledger.js';
import { readSettings, audit } from './state.js';
import { consumeToolBudget } from './tool-budget.js';
import { profileVersion } from './profiles.js';
import { evaluateProfile } from './evaluation.js';
type StoredProvider = typeof schema.providers.$inferSelect;
export { encryptSecret };
export async function providerViews(): Promise<ProviderView[]> {
  const rows = await db.select().from(schema.providers);
  const spent = (await pool.query("SELECT provider_id,sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at>=date_trunc('day',now()))::text daily,sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at>=date_trunc('month',now()))::text monthly FROM invocations GROUP BY provider_id")).rows;
  return rows.map(p => {
    const amount = spent.find(v => v.provider_id === p.id);
    const tested = p.capabilities ? Date.parse(p.capabilities.testedAt) : NaN;
    const ready = p.capabilities?.text && p.capabilities.structured && p.capabilities.usage && Number.isFinite(tested) && tested <= Date.now() && Date.now() - tested <= 30 * 86400000;
    const secret = ProviderSecretsSchema.parse(JSON.parse(decryptSecret(p.secrets)));
    return { ...p.config, id: p.id, version: p.version, hasSecret: !!secret.apiKey || Object.keys(secret.headers).length > 0, capabilities: p.capabilities, spentTodayUsd: amount?.daily ?? '0', spentMonthUsd: amount?.monthly ?? '0', status: !p.config.enabled ? 'unconfigured' : ready ? 'ready' : 'blocked', reason: !p.config.enabled ? 'Koneksi belum diaktifkan' : ready ? undefined : 'Uji kemampuan belum lulus' };
  });
}
export async function provider(id: string) { const [row] = await db.select().from(schema.providers).where(eq(schema.providers.id, id)); if (!row) throw new Error('Provider tidak ditemukan'); return row; }
export async function reserveInvocation(p: StoredProvider, role: string, mode: Mode, probe = false) {
  const c = p.config;
  if (c.inputPricePerMillion === undefined || c.outputPricePerMillion === undefined) throw new Error('Harga input/output token wajib diisi untuk membatasi biaya');
  const inputBound = probe ? 4096 : estimateInputTokenUpperBound();
  const reserve = d(inputBound).mul(c.inputPricePerMillion).plus(d(probe ? 128 : c.maxOutputTokens).mul(c.outputPricePerMillion)).div(1_000_000).mul(probe ? 1 : c.retries + 1);
  consumeToolBudget(reserve.toFixed());
  const { settings } = await readSettings();
  return transaction(async client => {
    await client.query('SELECT id FROM providers WHERE id=$1 FOR UPDATE', [p.id]);
    const current = (await client.query('SELECT version FROM providers WHERE id=$1', [p.id])).rows[0];
    if (!current || current.version !== p.version) throw new Error('Konfigurasi provider berubah');
    // All provider calls time out within 120 seconds; ten minutes also covers retry/DNS overhead.
    const abandoned = await client.query("UPDATE invocations SET status='failed',cost_status='unknown-reserved',error='Worker interrupted; maximum reservation retained',completed_at=now() WHERE provider_id=$1 AND status='running' AND created_at<now()-interval '10 minutes' RETURNING id,mode,reserved_cost", [p.id]);
    for (const invocation of abandoned.rows) {
      const amount = d(invocation.reserved_cost).mul(settings.serviceCostConversion);
      await postJournal(client, `service:${invocation.id}`, invocation.mode, 'operating-cost', 'Interrupted AI invocation: maximum reserved cost', [{ account: 'operating-cost', amount: amount.toFixed() }, { account: 'operating-payable', amount: amount.negated().toFixed() }], { invocationId: invocation.id, costUsd: invocation.reserved_cost, conversion: settings.serviceCostConversion, denomination: 'USD', valuation: 'estimated-pUSD' });
    }
    const budget = (await client.query("SELECT coalesce(sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at>=date_trunc('day',now())),0)::text daily,coalesce(sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at>=date_trunc('month',now())),0)::text monthly,count(*) FILTER(WHERE status='running')::int active,count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int rpm FROM invocations WHERE provider_id=$1", [p.id])).rows[0];
    if (d(c.dailyBudgetUsd).lte(0) || d(c.monthlyBudgetUsd).lte(0) || d(budget.daily).plus(reserve).gt(c.dailyBudgetUsd) || d(budget.monthly).plus(reserve).gt(c.monthlyBudgetUsd)) throw new Error('Anggaran provider tidak cukup untuk reservasi biaya maksimum');
    if (budget.active >= c.concurrency) throw new Error('Batas concurrency provider tercapai');
    if (budget.rpm >= c.callsPerMinute) throw new Error('Batas pemanggilan per menit tercapai');
    const inserted = await client.query("INSERT INTO invocations(provider_id,provider_version,model,role,mode,status,reserved_cost,cost_status) VALUES($1,$2,$3,$4,$5,'running',$6,'reserved') RETURNING id", [p.id, p.version, c.model, role, mode, reserve.toFixed()]);
    return { id: inserted.rows[0].id as string, providerId: p.id, reserved: reserve.toFixed(), config: c, mode };
  });
}
export async function finishInvocation(ticket: Awaited<ReturnType<typeof reserveInvocation>>, usage: Usage | null, latencyMs: number, error?: string) {
  const validCount = (value: number | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
  const known = validCount(usage?.inputTokens) && validCount(usage?.outputTokens);
  const cost = known ? d(usage!.inputTokens!).mul(ticket.config.inputPricePerMillion!).plus(d(usage!.outputTokens!).mul(ticket.config.outputPricePerMillion!)).div(1_000_000).toFixed() : null;
  const { settings } = await readSettings();
  await transaction(async client => {
    const row = (await client.query('SELECT cost,reserved_cost,completed_at FROM invocations WHERE id=$1 FOR UPDATE', [ticket.id])).rows[0];
    if (!row) throw new Error('Invocation record missing');
    if (!row.completed_at) await client.query("UPDATE invocations SET status=$1,cost=$2,cost_status=$3,input_tokens=$4,output_tokens=$5,latency_ms=$6,error=$7,completed_at=now() WHERE id=$8", [error ? 'failed' : 'complete', cost, known ? 'estimated' : 'unknown-reserved', known ? usage!.inputTokens : null, known ? usage!.outputTokens : null, Math.min(2_147_483_647, Math.max(0, Math.round(latencyMs))), error ?? null, ticket.id]);
    const billed = row.completed_at ? row.cost ?? row.reserved_cost : cost ?? ticket.reserved;
    const amount = d(billed).mul(settings.serviceCostConversion);
    await postJournal(client, `service:${ticket.id}`, ticket.mode, 'operating-cost', known ? 'AI token usage estimated cost' : 'AI uncertain usage: maximum reserved cost', [{ account: 'operating-cost', amount: amount.toFixed() }, { account: 'operating-payable', amount: amount.negated().toFixed() }], { invocationId: ticket.id, costUsd: billed, conversion: settings.serviceCostConversion, denomination: 'USD', valuation: 'estimated-pUSD' });
  });
  if (cost !== null && d(cost).gt(ticket.reserved)) { await db.update(schema.providers).set({ capabilities: null }).where(eq(schema.providers.id, ticket.providerId)); await audit('supervisor', 'Provider cost exceeded reservation', 'Reported usage exceeded conservative bound; invocation stopped', 'error', ticket.id); throw new Error('Provider cost exceeds reserved bound'); }
}
export async function probe(id: string) {
  const p = await provider(id), secrets = ProviderSecretsSchema.parse(JSON.parse(decryptSecret(p.secrets)));
  const sameVersion = and(eq(schema.providers.id, id), eq(schema.providers.version, p.version));
  // A retest immediately invalidates old readiness, even if a later reservation cannot proceed.
  await db.update(schema.providers).set({ capabilities: null }).where(sameVersion);
  const capabilities: Capabilities = { text: false, tools: false, structured: false, usage: true, testedAt: new Date().toISOString(), errors: [] };
  try {
    for (const capability of ['text', 'tools', 'structured'] as const) {
      const ticket = await reserveInvocation(p, `probe:${capability}`, 'paper', true);
      const result = await runCapabilityProbe(p.config, secrets, capability);
      capabilities[capability] = result.success;
      capabilities.usage &&= result.usageAvailable;
      if (result.error) capabilities.errors.push(`${capability}: ${result.error}`);
      await finishInvocation(ticket, result.usage, result.latencyMs, result.error);
    }
    const updated = await db.update(schema.providers).set({ capabilities, updatedAt: new Date() }).where(sameVersion).returning({ id: schema.providers.id });
    if (!updated.length) throw new Error('Provider changed during probe; capabilities not applied');
    await audit('supervisor', 'Uji koneksi AI selesai', `${p.config.name}: text=${capabilities.text}, tools=${capabilities.tools}, structured=${capabilities.structured}, usage=${capabilities.usage}`);
    return capabilities;
  } catch (error) {
    await db.update(schema.providers).set({ capabilities: null }).where(sameVersion);
    await audit('supervisor', 'Uji koneksi AI dihentikan', 'Readiness sebelumnya dibatalkan; reservasi biaya atau pencatatan invocation tidak selesai', 'warning');
    const safeReasons = new Set(['Harga input/output token wajib diisi untuk membatasi biaya','Konfigurasi provider berubah','Anggaran provider tidak cukup untuk reservasi biaya maksimum','Batas concurrency provider tercapai','Batas pemanggilan per menit tercapai','Agent cost budget exceeded']);
    if (error instanceof Error && safeReasons.has(error.message)) {
      // Only fixed locally generated errors can cross this boundary.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(error.message);
    }
    // Raw SDK causes can contain credentials; keep only the fixed public symptom.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Capability retest incomplete; prior readiness invalidated');
  }
}
export async function models(id: string) {
  const p = await provider(id), ticket = await reserveInvocation(p, 'model-discovery', 'paper', true), started = Date.now();
  let result: string[];
  try { result = await discoverModels(p.config, ProviderSecretsSchema.parse(JSON.parse(decryptSecret(p.secrets)))); }
  catch { await finishInvocation(ticket, null, Date.now() - started, 'Model discovery failed'); throw new Error('Model discovery failed'); }
  const official = !p.config.protocol.startsWith('custom-');
  await finishInvocation(ticket, official ? { inputTokens: 0, outputTokens: 0 } : null, Date.now() - started);
  await audit('supervisor', 'Model discovery completed', `${result.length} models returned; custom endpoint billing is reserved when unknown`, 'info', ticket.id);
  return result;
}
async function candidates(role: string, mode: Mode): Promise<StoredProvider[]> {
  const row = (await db.select().from(schema.assignments).where(eq(schema.assignments.role, role)))[0];
  if (!row) throw new Error(`Model untuk ${role} belum dipilih`);
  const ids = [row.primaryId, ...(row.fallbackEnabled ? row.fallbackIds : [])];
  const available: StoredProvider[] = [];
  for (const id of ids) {
    const p = await provider(id);
    const tested = p.capabilities ? Date.parse(p.capabilities.testedAt) : NaN;
    if (!p.config.enabled || !p.capabilities?.text || !p.capabilities.structured || !p.capabilities.usage || (role==='research'&&!p.capabilities.tools) || !Number.isFinite(tested) || tested > Date.now() || Date.now() - tested > 30 * 86400000) continue;
    if (mode === 'live') {
      // Upstream fallback choices are bound into every forecast profile, never silently substituted live.
      if (role !== 'forecast' && id !== row.primaryId) continue;
      if (role === 'forecast') {
        const { settings } = await readSettings();
        const evaluation = await evaluateProfile('prediction', settings, { providerId: p.id, providerVersion: p.version, model: p.config.model, protocol: p.config.protocol });
        if (!evaluation.eligible) continue;
      }
    }
    available.push(p);
  }
  if (!available.length) throw new Error('Tidak ada model aktif dengan kemampuan dan evaluasi yang sesuai');
  return available;
}
export async function forecast(market: Market, evidence: Evidence[], mode: Mode, beforeCall?: () => Promise<void>) {
  const list = await candidates('forecast', mode);
  for (const p of list) {
    await beforeCall?.();
    if (!market.active || market.closed || market.resolved || !market.acceptingOrders || !Number.isFinite(Date.parse(market.endDate)) || Date.parse(market.endDate) <= Date.now()) throw new Error('Market unavailable before forecast');
    let ticket: Awaited<ReturnType<typeof reserveInvocation>>;
    try { ticket = await reserveInvocation(p, 'forecast', mode); } catch { continue; }
    const start = Date.now();
    let result: Awaited<ReturnType<typeof runForecast>>;
    try { result = await runForecast({ ...p.config, retries: 0 }, ProviderSecretsSchema.parse(JSON.parse(decryptSecret(p.secrets))), { market, evidence }); }
    catch {
      await finishInvocation(ticket, null, Date.now() - start, 'Forecast failed; usage uncertain');
      await audit('forecast', 'AI forecast failed', `${p.config.name}: call failed`, 'warning');
      continue;
    }
    // Completion and ledger failures propagate; never issue a second paid call after bookkeeping fails.
    await finishInvocation(ticket, result.usage, result.latencyMs);
    const { settings } = await readSettings();
    const signalProfileVersion = await profileVersion('prediction', settings, { providerId: p.id, providerVersion: p.version, model: p.config.model, protocol: p.config.protocol });
    return { ...result, providerId: p.id, providerVersion: p.version, signalProfileVersion };
  }
  throw new Error('Semua koneksi yang diizinkan gagal; sinyal AI dihentikan');
}
export async function researchReady(mode: Mode): Promise<boolean> {
  try { for (const role of ['research','evidence','forecast']) await candidates(role,mode); return true; }
  catch { return false; }
}
export async function planResearch(market: Market, evidence: Evidence[], mode: Mode, beforeCall?: () => Promise<void>) {
  for (const p of await candidates('research', mode)) {
    await beforeCall?.();
    let ticket: Awaited<ReturnType<typeof reserveInvocation>>;
    try { ticket = await reserveInvocation(p, 'research', mode); } catch { continue; }
    const started = Date.now();
    let result: Awaited<ReturnType<typeof runResearchPlan>>;
    try { result = await runResearchPlan({ ...p.config, retries: 0 }, ProviderSecretsSchema.parse(JSON.parse(decryptSecret(p.secrets))), { market, evidence }); }
    catch { await finishInvocation(ticket, null, Date.now()-started, 'Research planner failed; usage uncertain'); continue; }
    await finishInvocation(ticket, result.usage, result.latencyMs);
    return result.plan;
  }
  throw new Error('Research tool planning unavailable');
}
export async function analyze(role: 'research' | 'evidence' | 'summary', market: Market, evidence: Evidence[], mode: Mode, beforeCall?: () => Promise<void>, validForecast?: Forecast) {
  for (const p of await candidates(role, mode)) {
    await beforeCall?.();
    if (!market.active || market.closed || market.resolved || !market.acceptingOrders || !Number.isFinite(Date.parse(market.endDate)) || Date.parse(market.endDate) <= Date.now()) throw new Error('Market unavailable before analysis');
    let ticket: Awaited<ReturnType<typeof reserveInvocation>>;
    try { ticket = await reserveInvocation(p, role, mode); } catch { continue; }
    const started = Date.now();
    let result: Awaited<ReturnType<typeof runEvidenceAnalysis>>;
    try { result = await runEvidenceAnalysis({ ...p.config, retries: 0 }, ProviderSecretsSchema.parse(JSON.parse(decryptSecret(p.secrets))), { role, question: market.question + '\n' + market.description + '\nResolution authority: ' + market.resolutionSource, evidence, forecast: validForecast }); }
    catch { await finishInvocation(ticket, null, Date.now() - started, 'Analysis failed'); continue; }
    await finishInvocation(ticket, result.usage, result.latencyMs);
    return result.analysis;
  }
  throw new Error('Analisis bukti tidak tersedia');
}
