import { transaction } from '../../db/src/index.js';
import { d, postJournal } from '../../core/src/ledger.js';
import { readSettings, audit, writeState } from '../../core/src/state.js';
import { readServiceConfig, researchCredential } from './settings.js';
import { tavily } from '@tavily/core';
import type { Mode } from '../../shared/src/index.js';
import { publicSourceUrl } from './public-fetch.js';
import { consumeToolBudget } from '../../core/src/tool-budget.js';
export async function metered<T extends { usage?: { credits: number } }>(mode: Mode, action: string, maxCredits: number, invoke: () => Promise<T>): Promise<T> {
  const service = await readServiceConfig(); if (!service.config.tavily.enabled) throw new Error('Search service disabled');
  const { settings } = await readSettings(), reserved = d(maxCredits).mul(service.config.tavily.costPerCreditUsd);
  if (reserved.lte(0)) throw new Error('Positive research unit price required');
  consumeToolBudget(reserved.toFixed());
  const ticket = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73030)');
    const abandoned = await client.query("UPDATE invocations SET status='failed',cost_status='unknown-reserved',error='Worker interrupted; maximum search reservation retained',completed_at=now() WHERE model='tavily' AND status='running' AND created_at<now()-interval '10 minutes' RETURNING id,mode,reserved_cost");
    for (const row of abandoned.rows) {
      const amount = d(row.reserved_cost).mul(settings.serviceCostConversion);
      await postJournal(client,`service:${row.id}`,row.mode,'operating-cost','Interrupted search: maximum reserved cost',[{account:'operating-cost',amount:amount.toFixed()},{account:'operating-payable',amount:amount.negated().toFixed()}],{invocationId:row.id,costUsd:row.reserved_cost,conversion:settings.serviceCostConversion,denomination:'USD',valuation:'estimated-pUSD'});
    }
    const total = (await client.query("SELECT coalesce(sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at>=date_trunc('day',now())),0)::text daily,coalesce(sum(coalesce(cost,reserved_cost)) FILTER(WHERE created_at>=date_trunc('month',now())),0)::text monthly,count(*) FILTER(WHERE status='running')::int active,count(*) FILTER(WHERE created_at>=now()-interval '1 minute')::int rpm FROM invocations WHERE model='tavily'")).rows[0];
    if (d(settings.researchDailyBudgetUsd).lte(0) || d(settings.researchMonthlyBudgetUsd).lte(0) || d(total.daily).plus(reserved).gt(settings.researchDailyBudgetUsd) || d(total.monthly).plus(reserved).gt(settings.researchMonthlyBudgetUsd)) throw new Error('Research budget unavailable');
    if (total.active >= 2 || total.rpm >= 20) throw new Error('Research concurrency or rate limit reached');
    return (await client.query("INSERT INTO invocations(provider_id,model,role,mode,status,reserved_cost,cost_status) VALUES(NULL,'tavily','research',$1,'running',$2,'reserved') RETURNING id", [mode, reserved.toFixed()])).rows[0].id as string;
  });
  const started = Date.now();
  let response: T;
  try { response = await invoke(); }
  catch {
    await transaction(async client => { await client.query("UPDATE invocations SET status='failed',cost_status='unknown-reserved',error='Research request failed; billing uncertain',latency_ms=$1,completed_at=now() WHERE id=$2", [Date.now() - started, ticket]); const amount = reserved.mul(settings.serviceCostConversion); await postJournal(client, `service:${ticket}`, mode, 'operating-cost', 'Research failure: maximum cost reserved', [{ account: 'operating-cost', amount: amount.toFixed() }, { account: 'operating-payable', amount: amount.negated().toFixed() }], { costUsd: reserved.toFixed(), conversion: settings.serviceCostConversion, denomination: 'USD', valuation: 'estimated-pUSD' }); });
    throw new Error('Research provider failed; billing remains reserved');
  }
  const credits = response.usage?.credits;
  const known = typeof credits === 'number' && Number.isFinite(credits) && credits >= 0;
  const cost = known ? d(credits).mul(service.config.tavily.costPerCreditUsd).toFixed() : null;
  await transaction(async client => { await client.query("UPDATE invocations SET status='complete',cost=$1,cost_status=$2,latency_ms=$3,completed_at=now() WHERE id=$4", [cost, known ? 'reported-credits' : 'unknown-reserved', Date.now() - started, ticket]); const amount = d(cost ?? reserved.toFixed()).mul(settings.serviceCostConversion); await postJournal(client, `service:${ticket}`, mode, 'operating-cost', `Research ${action}`, [{ account: 'operating-cost', amount: amount.toFixed() }, { account: 'operating-payable', amount: amount.negated().toFixed() }], { costUsd: cost ?? reserved.toFixed(), conversion: settings.serviceCostConversion, denomination: 'USD', valuation: 'estimated-pUSD' }); });
  if (known && credits > maxCredits) { await audit('research', 'Research cost exceeded reservation', 'Reported credits exceeded conservative request reservation; further requests stopped', 'error', ticket); throw new Error('Research credits exceeded reservation'); }
  return response;
}
export async function probeSearch(mode: Mode) {
  const { version } = await readServiceConfig();
  const checkedAt = new Date().toISOString();
  await writeState('services-search-probe', { version, ok: false, checkedAt, resultCount: 0, credits: null, message: 'Connection test in progress or interrupted' });
  try {
    const apiKey = await researchCredential(); if (!apiKey) throw new Error('Search credential not configured');
    const client = tavily({ apiKey, apiBaseURL: 'https://api.tavily.com' });
    const result = await metered(mode, 'connection test', 1, () => client.search('Federal Reserve latest official press release', { searchDepth: 'basic', topic: 'news', days: 1, timeRange: 'day', maxResults: 2, includeAnswer: false, includeRawContent: false, includeUsage: true, autoParameters: false, timeout: 30 }));
    const usable = await Promise.all(result.results.slice(0, 2).map(async row => typeof row.title === 'string' && !!row.title.trim() && typeof row.content === 'string' && !!row.content.trim() && !!await publicSourceUrl(row.url)));
    const valid = usable.some(Boolean);
    const probe = { version, ok: valid, checkedAt: new Date().toISOString(), resultCount: usable.filter(Boolean).length, credits: result.usage?.credits ?? null, message: valid ? 'Search returned usable source results; metered request charged' : 'Search responded without usable source results; metered request charged' };
    await writeState('services-search-probe', probe);
    return probe;
  } catch {
    await writeState('services-search-probe', { version, ok: false, checkedAt: new Date().toISOString(), resultCount: 0, credits: null, message: 'Connection test failed; check credential, enabled service and budget. Billing may remain reserved.' });
    throw new Error('Search connection test failed');
  }
}
export async function searchNews(query: string, mode: Mode) {
  if (!query.trim() || query.length > 1000 || [...query].some(character => character.charCodeAt(0) < 32)) throw new Error('Invalid news query');
  const apiKey = await researchCredential(); if (!apiKey) throw new Error('Search credential not configured');
  const client = tavily({ apiKey, apiBaseURL: 'https://api.tavily.com' });
  const response = await metered(mode, 'manual news search', 1, () => client.search(query.trim(), { searchDepth: 'basic', topic: 'news', days: 1, timeRange: 'day', maxResults: 6, includeAnswer: false, includeRawContent: false, includeUsage: true, autoParameters: false, timeout: 30 }));
  const checkedAt = new Date().toISOString();
  const candidates = await Promise.all(response.results.slice(0, 6).map(async row => { const url = await publicSourceUrl(row.url), published = Date.parse(row.publishedDate); if (!url || !Number.isFinite(published) || published > Date.now() + 60000 || Date.now() - published > 86400000) return null; return { url, title: row.title.slice(0, 500), excerpt: row.content.slice(0, 1500), publishedAt: new Date(published).toISOString(), retrievedAt: checkedAt, verified: false, kind: 'news' }; }));
  return { items: [...new Map(candidates.filter(item => item !== null).map(item => [item.url, item])).values()], checkedAt, credits: response.usage?.credits ?? null };
}
