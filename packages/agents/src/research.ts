import { createHash, randomUUID } from 'node:crypto';
import { tavily } from '@tavily/core';
import { pool } from '../../db/src/index.js';
import { audit } from '../../core/src/state.js';
import { metered } from '../../services/src/search.js';
import { readServiceConfig, researchCredential } from '../../services/src/settings.js';
import { publicSourceUrl } from '../../services/src/public-fetch.js';
import { loadTrends, relatedMarkets } from '../../services/src/trends.js';
import type { Market, Mode, Evidence } from '../../shared/src/index.js';
import { ResearchQuerySchema } from '../../ai/src/index.js';
async function rssEvidence(market: Market): Promise<Evidence[]> {
  const trends = await loadTrends();
  return trends.items.filter(item => item.freshness === 'fresh' && relatedMarkets(item.title, item.excerpt, [market]).length).slice(0, 8).map(item => ({ id: item.id, url: item.url, title: item.title, content: `[RSS EXCERPT ONLY: source text unverified; insufficient alone for a probability forecast; abstain unless verified source text is available.] ${item.excerpt}`, publishedAt: item.publishedAt, retrievedAt: item.retrievedAt, primary: item.primary, hash: item.hash }));
}
/** Search/extract only through fixed Tavily service. Returned source text is data, never executable instructions. */
export async function researchMarket(market: Market, mode: Mode, queryOverride?: string): Promise<Evidence[]> {
  if (market.question.length > 16000 || market.resolutionSource.length > 4096 || !market.active || market.closed) throw new Error('Invalid research market');
  const service = await readServiceConfig(), apiKey = await researchCredential();
  if (!apiKey || !service.config.tavily.enabled) return rssEvidence(market);
  const client = tavily({ apiKey, apiBaseURL: 'https://api.tavily.com' });
  const query = queryOverride === undefined ? market.question.slice(0,1000) : ResearchQuerySchema.parse(queryOverride);
  const search = await metered(mode, 'search', 1, () => client.search(query, { searchDepth: 'basic', autoParameters: false, maxResults: 6, topic: 'news', days: 1, timeRange: 'day', includeAnswer: false, includeRawContent: false, includeUsage: true, timeout: 30 }));
  let authority: string | null = null;
  const resolutionUrl = await publicSourceUrl(market.resolutionSource);
  if (resolutionUrl) authority = new URL(resolutionUrl).hostname.toLowerCase();
  const official = authority ? await metered(mode, 'resolution source search', 1, () => client.search(market.question.slice(0, 1000), { searchDepth: 'basic', topic: 'general', includeDomains: [authority!], includeDomainsMode: 'restrict', maxResults: 2, includeAnswer: false, includeRawContent: false, includeUsage: true, autoParameters: false, timeout: 30 })) : null;
  const candidates = await Promise.all([...(official?.results ?? []), ...search.results].slice(0, 8).map(async row => ({ row, url: await publicSourceUrl(row.url) })));
  const urls = [...new Set(candidates.flatMap(item => item.url ? [item.url] : []))];
  if (!urls.length) return [];
  const extracted = await metered(mode, 'extract', Math.ceil(urls.length / 5), () => client.extract(urls, { extractDepth: 'basic', format: 'text', includeUsage: true, timeout: 30 }));
  const evidence: Evidence[] = [], now = new Date().toISOString();
  for (const row of extracted.results.slice(0, 8)) {
    const url = await publicSourceUrl(row.url); if (!url || !urls.includes(url)) continue;
    const found = candidates.find(item => item.url === url)?.row;
    const published = found?.publishedDate ? Date.parse(found.publishedDate) : NaN;
    if (Number.isFinite(published) && (published > Date.now() + 60000 || Date.now() - published > 86400000)) continue;
    const content = row.rawContent.slice(0, 12000); if (!content.trim()) continue;
    const hash = createHash('sha256').update(url + '\n' + content).digest('hex');
    const item: Evidence = { id: randomUUID(), url, title: (row.title ?? found?.title ?? '').slice(0, 500), content, publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null, retrievedAt: now, primary: authority !== null && new URL(url).hostname.toLowerCase() === authority, hash };
    const stored = await pool.query('INSERT INTO evidence(id,market_id,payload,hash) VALUES($1,$2,$3,$4) ON CONFLICT(market_id,hash) DO UPDATE SET payload=excluded.payload RETURNING id,payload', [item.id, market.id, item, hash]);
    evidence.push({ ...stored.rows[0].payload, id: stored.rows[0].id });
  }
  await audit('research', 'Research evidence stored', `${evidence.length} bounded sources for market ${market.id}`);
  return evidence;
}
