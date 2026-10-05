export const MARKET_STREAM_CHANNEL = 'polymarket:market-stream:v1';
export const MARKET_STREAM_KEY = 'polymarket:market-stream:state:v1';
export const QUOTE_KEY_PREFIX = 'polymarket:quote:v1:';
export const QUOTE_MAX_AGE_MS = 2000;
export const ENTRY_BOOK_MAX_AGE_MS = 1000;
export const FEED_IDLE_TIMEOUT_MS = 15000;
export const STREAM_COALESCE_MS = 100;

export interface MarketQuote {
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  bid: string | null;
  ask: string | null;
  last: string | null;
  exchangeAt: number | null;
  receivedAt: number;
  event: string;
  depth?: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[]; exchangeAt: number | null; receivedAt: number };
}
export interface StreamStatus {
  connected: boolean;
  epoch: string;
  at: number;
  lastEventAt: number | null;
  tokens: string[];
  reason: string;
  events: number;
  rejected: number;
  exchangeLagMs: number | null;
}
export interface StreamUpdate { status: StreamStatus; quotes: MarketQuote[]; publishedAt: number }
export interface SignalTiming {
  marketId: string;
  at: string;
  queueMs: number;
  quoteAgeMs: number;
  validationMs: number;
  totalMs: number;
  considered: boolean;
  reason: string;
}
export function quoteFresh(quote: MarketQuote | null | undefined, now = Date.now()) {
  return !!quote && quote.exchangeAt !== null && Number.isFinite(quote.exchangeAt)
    && now - quote.receivedAt <= QUOTE_MAX_AGE_MS && quote.receivedAt <= now + 1000
    && now - quote.exchangeAt <= QUOTE_MAX_AGE_MS && quote.exchangeAt <= now + 1000;
}
