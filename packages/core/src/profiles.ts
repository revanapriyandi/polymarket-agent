import { createHash } from 'node:crypto';
import { pool } from '../../db/src/index.js';
import type { Settings } from '../../shared/src/index.js';
import { skills } from '../../agents/src/registry.js';
export interface SelectedForecastModel { providerId: string; providerVersion: number; model: string; protocol: string }
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value; }
/** Secret-free profile identity; any policy/model/allowed-fallback change requires new measured evidence. */
export async function profileVersion(strategy: string, settings: Settings, selected?: SelectedForecastModel): Promise<string> {
  const assignments = strategy === 'prediction' ? (await pool.query('SELECT role,primary_id,fallback_enabled,fallback_ids FROM assignments ORDER BY role')).rows : [];
  const ids = [...new Set(assignments.flatMap(row => [row.primary_id, ...(row.fallback_enabled ? row.fallback_ids : [])]))].sort();
  const model = ids.length ? (await pool.query('SELECT id,version,config FROM providers WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows : [];
  const forecast = assignments.find(row => row.role === 'forecast');
  const primary = model.find(row => row.id === forecast?.primary_id);
  const actual = selected ?? (primary ? { providerId: primary.id, providerVersion: primary.version, model: primary.config.model, protocol: primary.config.protocol } : null);
  const config = { strategy, engine: '1.3.0', skills:skills.map(skill=>({id:skill.id,version:skill.version})), paperRisk: settings.paper, liveRisk: settings.live, strategies: settings.strategyEnabled, assignments, model, actualForecastModel: actual, latency: settings.paperLatencyMs, failure: settings.paperFailureRate, serviceCostConversion: settings.serviceCostConversion, infrastructureDailyCostUsd: settings.infrastructureDailyCostUsd };
  return createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex').slice(0, 20);
}

/** Explicitly configured forecast choices; stale/deleted configurations never create a fallback profile. */
export async function selectedForecastProfiles(): Promise<SelectedForecastModel[]> {
  const row = (await pool.query("SELECT primary_id,fallback_enabled,fallback_ids FROM assignments WHERE role='forecast'")).rows[0];
  if (!row) return [];
  const ids: string[] = [...new Set<string>([row.primary_id, ...(row.fallback_enabled ? row.fallback_ids : [])])];
  const providers = (await pool.query('SELECT id,version,config FROM providers WHERE id=ANY($1::uuid[])', [ids])).rows;
  return ids.flatMap(id => { const provider = providers.find(value => value.id === id); return provider?.config.enabled ? [{ providerId: provider.id, providerVersion: provider.version, model: provider.config.model, protocol: provider.config.protocol }] : []; });
}
