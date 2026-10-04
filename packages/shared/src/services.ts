import { z } from 'zod';

export const ServiceSettingsSchema = z.object({
  news: z.object({ enabled: z.boolean(), intervalSeconds: z.number().int().min(300).max(86400), maxAgeHours: z.number().int().min(1).max(24), feeds: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,60}$/), name: z.string().min(1).max(100), url: z.string().url().max(2048).refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443'); }, 'Public HTTPS feed required'), enabled: z.boolean(), primary: z.boolean() })).max(10).refine(feeds => new Set(feeds.map(f => f.id)).size === feeds.length, 'Duplicate feed identifier') }),
  tavily: z.object({ enabled: z.boolean(), costPerCreditUsd: z.string().regex(/^\d+(\.\d{1,8})?$/).refine(value => Number(value) > 0 && Number(value) <= 1, 'Positive credit price required') }),
});
export type ServiceSettings = z.infer<typeof ServiceSettingsSchema>;
export const defaultServices: ServiceSettings = { news: { enabled: true, intervalSeconds: 300, maxAgeHours: 24, feeds: [{ id: 'federal-reserve', name: 'Federal Reserve releases', url: 'https://www.federalreserve.gov/feeds/press_all.xml', enabled: true, primary: true }, { id: 'bbc-world', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', enabled: true, primary: false }] }, tavily: { enabled: false, costPerCreditUsd: '0.008' } };
export interface TrendItem { id: string; hash: string; url: string; title: string; excerpt: string; sourceId: string; sourceName: string; sourceUrl: string; primary: boolean; publishedAt: string | null; retrievedAt: string; freshUntil: string; freshness: 'fresh' | 'stale' | 'undated'; marketIds: string[]; kind: 'news'; verified: false }
export interface TrendsView { items: TrendItem[]; checkedAt: string | null; errors: { sourceId: string; message: string }[] }
export interface SearchProbe { version: number; ok: boolean; checkedAt: string; resultCount: number; credits: number | null; message: string }
export interface ServiceView { config: ServiceSettings; version: number; hasTavilyKey: boolean; keySource: 'stored' | 'environment' | 'none'; searchStatus: 'disabled' | 'unconfigured' | 'untested' | 'ready' | 'blocked'; probe: SearchProbe | null; spentTodayUsd: string; spentMonthUsd: string }
