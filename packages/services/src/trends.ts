import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { transaction } from '../../db/src/index.js';
import { readState } from '../../core/src/state.js';
import type { Market } from '../../shared/src/index.js';
import type { TrendItem, TrendsView } from '../../shared/src/services.js';
import { readServiceConfig } from './settings.js';
import { fetchPublicSource, publicSourceUrl } from './public-fetch.js';
const stopwords = new Set('will the and for with from this that have has was were are what when where who how before after above below than into over under yes not price market election win more less next year month week day million billion percent election president country'.split(' '));
function tokens(value: string): string[] { return [...new Set((value.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter(word => !stopwords.has(word)))]; }
export function relatedMarkets(title: string, excerpt: string, markets: Market[]): string[] { const text = new Set(tokens(`${title} ${excerpt}`)); return markets.filter(m => { const keywords = tokens(m.question); const matches = keywords.filter(word => text.has(word)); return matches.length >= 2 || keywords.length === 1 && matches.length === 1 && keywords[0]!.length >= 7; }).map(m => m.id); }
function plain(value: unknown, maximum: number): string { return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : ''; }
function rows(value: unknown): Record<string, unknown>[] { return (Array.isArray(value) ? value : value ? [value] : []).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null); }
export async function loadTrends(): Promise<TrendsView> { const view = await readState<TrendsView>('news-trends') ?? { items: [], checkedAt: null, errors: [] }; return { ...view, items: view.items.map(item => ({ ...item, freshness: item.publishedAt === null ? 'undated' : Date.parse(item.freshUntil) > Date.now() ? 'fresh' : 'stale' })) }; }
export async function refreshTrends(markets: Market[]): Promise<TrendsView & { checkedAt: string; affectedMarketIds: string[] }> {
  const { config } = await readServiceConfig(), now = new Date().toISOString(), previous = await loadTrends();
  if (!config.news.enabled || previous.checkedAt && Date.now() - Date.parse(previous.checkedAt) < config.news.intervalSeconds * 1000) return { ...previous, checkedAt: previous.checkedAt ?? now, affectedMarketIds: [] };
  const items: TrendItem[] = [], errors: TrendsView['errors'] = [];
  for (const source of config.news.feeds.filter(feed => feed.enabled)) {
    try {
      const xml = await fetchPublicSource(source.url);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Unsafe or invalid feed XML');
      const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false, trimValues: true }).parse(xml);
      const entries = rows(parsed.rss?.channel?.item ?? parsed.feed?.entry).slice(0, 50);
      if (!entries.length) throw new Error('Feed contains no supported entries');
      for (const row of entries) {
        const rawLink = typeof row.link === 'string' ? row.link : rows(row.link).find(link => !link['@_rel'] || link['@_rel'] === 'alternate')?.['@_href'];
        const url = typeof rawLink === 'string' ? await publicSourceUrl(rawLink) : null; if (!url) continue;
        const title = plain(row.title, 500), excerpt = plain(row.description ?? row.summary ?? row.content, 1500); if (!title) continue;
        const timestamp = Date.parse(plain(row.pubDate ?? row.published ?? row.updated, 100));
        const publishedAt = Number.isFinite(timestamp) && timestamp <= Date.now() + 60000 ? new Date(timestamp).toISOString() : null;
        const freshUntil = publishedAt ? new Date(timestamp + config.news.maxAgeHours * 3600000).toISOString() : now;
        const primary = source.primary && new URL(url).hostname === new URL(source.url).hostname;
        const hash = createHash('sha256').update(`${url}\n${title}\n${excerpt}\n${publishedAt}`).digest('hex');
        items.push({ id: createHash('sha256').update(url).digest('hex'), hash, url, title, excerpt, sourceId: source.id, sourceName: source.name, sourceUrl: source.url, primary, publishedAt, retrievedAt: now, freshUntil, freshness: !publishedAt ? 'undated' : Date.parse(freshUntil) > Date.now() ? 'fresh' : 'stale', marketIds: relatedMarkets(title, excerpt, markets), kind: 'news', verified: false });
      }
    } catch { errors.push({ sourceId: source.id, message: 'Feed unavailable or rejected by public-source validation' }); }
  }
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73032)');
    const existing = (await client.query("SELECT value FROM system_state WHERE key='news-trends' FOR UPDATE")).rows[0]?.value as TrendsView | undefined;
    const baseline = existing ?? previous, known = new Set(baseline.items.map(item => item.hash));
    const affectedMarketIds = [...new Set(items.filter(item => item.freshness === 'fresh' && !known.has(item.hash)).flatMap(item => item.marketIds))];
    const merged = [...new Map([...items, ...baseline.items.filter(item => config.news.feeds.some(feed => feed.enabled && feed.id === item.sourceId))].map(item => [item.id, item])).values()];
    // Current observations win over previously retained copies of the same URL.
    for (const item of items) { const index = merged.findIndex(old => old.id === item.id); merged[index] = item; }
    const view: TrendsView = { items: merged.sort((a, b) => Date.parse(b.publishedAt ?? b.retrievedAt) - Date.parse(a.publishedAt ?? a.retrievedAt)).slice(0, 100), checkedAt: now, errors };
    await client.query("INSERT INTO system_state(key,value) VALUES('news-trends',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", [JSON.stringify(view)]);
    return { ...view, checkedAt: now, affectedMarketIds };
  });
}
