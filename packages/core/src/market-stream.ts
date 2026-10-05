import { redis } from './queue.js';
import { MARKET_STREAM_KEY, QUOTE_KEY_PREFIX, FEED_IDLE_TIMEOUT_MS, quoteFresh, type StreamStatus, type MarketQuote, type StreamUpdate } from '../../shared/src/realtime.js';

export async function streamSnapshot(): Promise<StreamUpdate> {
  const raw = await redis.get(MARKET_STREAM_KEY);
  const status: StreamStatus = raw ? JSON.parse(raw) : { connected: false, epoch: '', at: Date.now(), lastEventAt: null, tokens: [], reason: 'Menunggu stream worker', events: 0, rejected: 0, exchangeLagMs: null };
  if (Date.now() - status.at > FEED_IDLE_TIMEOUT_MS || !status.lastEventAt || Date.now() - status.lastEventAt > FEED_IDLE_TIMEOUT_MS) { status.connected = false; status.reason = 'Stream belum menerima data segar'; }
  const quotes: MarketQuote[] = status.tokens.length ? (await redis.mget(status.tokens.map(token => QUOTE_KEY_PREFIX + token))).flatMap(raw => raw ? [JSON.parse(raw) as MarketQuote] : []) : [];
  return { status, quotes, publishedAt: Date.now() };
}
export async function entryFeedGuard(tokenIds: string[]): Promise<{ ready: boolean; reason: string }> {
  const [state, ...values] = await redis.mget([MARKET_STREAM_KEY, ...tokenIds.map(token => QUOTE_KEY_PREFIX + token)]);
  if (!state) return { ready: false, reason: 'Entry menunggu WebSocket pasar' };
  const status: StreamStatus = JSON.parse(state), now = Date.now();
  if (!status.connected || now - status.at > FEED_IDLE_TIMEOUT_MS || !status.lastEventAt || now - status.lastEventAt > FEED_IDLE_TIMEOUT_MS) return { ready: false, reason: 'Entry diblokir: stream terputus atau terlambat' };
  if (tokenIds.some((token, index) => !status.tokens.includes(token) || !values[index] || !quoteFresh(JSON.parse(values[index]!), now))) return { ready: false, reason: 'Entry diblokir: harga WebSocket lebih lama dari 2 detik atau timestamp belum terverifikasi' };
  return { ready: true, reason: 'Stream dan harga masih segar' };
}
