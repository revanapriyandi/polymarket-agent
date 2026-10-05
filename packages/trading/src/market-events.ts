import { z } from 'zod';
import type { Market, BookLevel } from '../../shared/src/index.js';
import type { MarketQuote } from '../../shared/src/realtime.js';

const price = z.string().max(80).regex(/^\d+(\.\d+)?$/).refine(value => Number(value) >= 0 && Number(value) <= 1);
const size = z.string().max(80).regex(/^\d+(\.\d+)?$/).refine(value => Number.isFinite(Number(value)));
const level = z.object({ price, size });
const token = z.string().min(1).max(100);
const stamp = z.union([z.string().max(40), z.number()]).nullish();
const schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('book'), payload: z.object({ tokenId: token, bids: z.array(level).max(20000), asks: z.array(level).max(20000), timestamp: stamp }) }),
  z.object({ type: z.literal('price_change'), payload: z.object({ priceChanges: z.array(z.object({ tokenId: token, price, size, side: z.enum(['BUY','SELL']), bestBid: price.nullish(), bestAsk: price.nullish() })).max(2000), timestamp: stamp }) }),
  z.object({ type: z.literal('best_bid_ask'), payload: z.object({ tokenId: token, bestBid: price.nullish(), bestAsk: price.nullish(), timestamp: stamp }) }),
]);
function timestamp(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value), parsed = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Display depth only. Execution always revalidates a fresh official REST book. */
export class DisplayBooks {
  private books = new Map<string, { bids: Map<string,string>; asks: Map<string,string>; exchangeAt: number | null; receivedAt: number }>();
  clear() { this.books.clear(); }
  update(raw: unknown, now: number) {
    const parsed = schema.safeParse(raw); if (!parsed.success) return;
    const event = parsed.data, at = timestamp(event.payload.timestamp);
    if (at === null || at > now + 1000) return;
    if (event.type === 'book') {
      const previous = this.books.get(event.payload.tokenId);
      if (previous?.exchangeAt && previous.exchangeAt > at) return;
      this.books.set(event.payload.tokenId, { bids: new Map(event.payload.bids.filter(row=>Number(row.size)>0).map(row=>[String(Number(row.price)),row.size])), asks: new Map(event.payload.asks.filter(row=>Number(row.size)>0).map(row=>[String(Number(row.price)),row.size])), exchangeAt: at, receivedAt: now });
    } else if (event.type === 'price_change') {
      for (const change of event.payload.priceChanges) {
        const book = this.books.get(change.tokenId); if (!book || book.exchangeAt !== null && book.exchangeAt > at) continue;
        const levels = change.side === 'BUY' ? book.bids : book.asks, key = String(Number(change.price));
        if (Number(change.size) === 0) levels.delete(key); else levels.set(key,change.size);
        if (levels.size > 20000) { this.books.delete(change.tokenId); continue; }
        book.exchangeAt = at; book.receivedAt = now;
      }
    }
  }
  view(quote: MarketQuote): MarketQuote['depth'] {
    const book = this.books.get(quote.tokenId); if (!book) return;
    const bids = [...book.bids].sort((a,b)=>Number(b[0])-Number(a[0])).slice(0,15).map(([price,size])=>({price,size}));
    const asks = [...book.asks].sort((a,b)=>Number(a[0])-Number(b[0])).slice(0,15).map(([price,size])=>({price,size}));
    if ((bids[0]?.price??null) !== quote.bid || (asks[0]?.price??null) !== quote.ask) { this.books.delete(quote.tokenId); return; }
    return { bids, asks, exchangeAt: book.exchangeAt, receivedAt: book.receivedAt };
  }
}
function best(levels: BookLevel[], side: 'bid' | 'ask') {
  const prices = levels.filter(item => Number(item.size) > 0).map(item => Number(item.price));
  return prices.length ? String(side === 'bid' ? Math.max(...prices) : Math.min(...prices)) : null;
}
/** Only full top-of-book observations refresh a quote; trades/tick changes cannot refresh stale prices. */
export function parseMarketQuotes(raw: unknown, tokens: Map<string, Market>, receivedAt: number): MarketQuote[] {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return [];
  const event = parsed.data, exchangeAt = timestamp(event.payload.timestamp);
  const values = event.type === 'book' ? [{ tokenId: event.payload.tokenId, bestBid: best(event.payload.bids, 'bid'), bestAsk: best(event.payload.asks, 'ask') }]
    : event.type === 'price_change' ? event.payload.priceChanges : [event.payload];
  return values.flatMap(value => {
    const market = tokens.get(value.tokenId);
    if (!market || value.bestBid === undefined || value.bestAsk === undefined) return [];
    const bid = value.bestBid == null || Number(value.bestBid) === 0 ? null : String(Number(value.bestBid));
    const ask = value.bestAsk == null || Number(value.bestAsk) === 1 ? null : String(Number(value.bestAsk));
    if (bid !== null && ask !== null && Number(bid) > Number(ask)) return [];
    return [{ marketId: market.id, tokenId: value.tokenId, outcome: value.tokenId === market.yesToken ? 'YES' as const : 'NO' as const, bid, ask, last: null, exchangeAt, receivedAt, event: event.type }];
  });
}
