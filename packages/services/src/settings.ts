import { pool, transaction } from '../../db/src/index.js';
import { readState, readSettings, audit } from '../../core/src/state.js';
import { env } from '../../core/src/config.js';
import { encryptSecret, decryptSecret } from '../../ai/src/security.js';
import { defaultServices, ServiceSettingsSchema, type ServiceSettings, type ServiceView, type SearchProbe } from '../../shared/src/services.js';
export async function readServiceConfig(): Promise<{ config: ServiceSettings; version: number }> { const stored = await readState<{ config: ServiceSettings; version: number }>('services-config'); return stored ? { config: ServiceSettingsSchema.parse(stored.config), version: stored.version } : { config: defaultServices, version: 0 }; }
export async function researchCredential(): Promise<string | null> { const stored = await readState<{ tavily: string | null }>('services-secrets'); return stored?.tavily ? decryptSecret(stored.tavily) : env.TAVILY_API_KEY || null; }
export async function readServiceView(): Promise<ServiceView> {
  const [stored, secure, budgets, spending] = await Promise.all([readServiceConfig(), readState<{ tavily: string | null }>('services-secrets'), readSettings(), pool.query("SELECT coalesce(sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at >= date_trunc('day',now())),0)::text daily,coalesce(sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at >= date_trunc('month',now())),0)::text monthly FROM invocations WHERE model='tavily'")]);
  const keySource = secure?.tavily ? 'stored' : env.TAVILY_API_KEY ? 'environment' : 'none', hasTavilyKey = keySource !== 'none';
  const daily = spending.rows[0].daily, monthly = spending.rows[0].monthly;
  const lastProbe = await readState<SearchProbe>('services-search-probe');
  const probe = lastProbe?.version === stored.version ? lastProbe : null;
  const tested = probe?.ok && Date.now() - Date.parse(probe.checkedAt) < 86400000;
  return { ...stored, hasTavilyKey, keySource, probe, searchStatus: !stored.config.tavily.enabled ? 'disabled' : !hasTavilyKey ? 'unconfigured' : Number(budgets.settings.researchDailyBudgetUsd) <= Number(daily) || Number(budgets.settings.researchMonthlyBudgetUsd) <= Number(monthly) || probe?.ok === false ? 'blocked' : tested ? 'ready' : 'untested', spentTodayUsd: daily, spentMonthUsd: monthly };
}
export async function saveServices(expectedVersion: number, input: unknown, apiKey?: string): Promise<ServiceView> {
  const config = ServiceSettingsSchema.parse(input);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid service version');
  if (apiKey !== undefined && (apiKey.length > 4096 || /[\r\n]/.test(apiKey))) throw new Error('Invalid service credential');
  const encrypted = apiKey === undefined ? undefined : apiKey.trim() ? encryptSecret(apiKey.trim()) : null;
  await transaction(async client => { await client.query('SELECT pg_advisory_xact_lock(73031)'); const existing = (await client.query("SELECT value FROM system_state WHERE key='services-config' FOR UPDATE")).rows[0]; if ((existing?.value.version ?? 0) !== expectedVersion) throw new Error('Service settings version conflict'); await client.query("INSERT INTO system_state(key,value) VALUES('services-config',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", [JSON.stringify({ config, version: expectedVersion + 1 })]); if (encrypted !== undefined) await client.query("INSERT INTO system_state(key,value) VALUES('services-secrets',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", [JSON.stringify({ tavily: encrypted })]); });
  await audit('research', 'Services settings updated', `Configuration version ${expectedVersion + 1}`); return readServiceView();
}
