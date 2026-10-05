import { randomUUID } from 'node:crypto';
import { pool } from '../../../packages/db/src/index.js';
import { redis, signalsQueue, operationsQueue } from '../../../packages/core/src/queue.js';
import { readSettings, readControl, writeState } from '../../../packages/core/src/state.js';
import { logger } from '../../../packages/core/src/logger.js';
import { parseMarketQuotes, DisplayBooks } from '../../../packages/trading/src/market-events.js';
import { MARKET_STREAM_CHANNEL, MARKET_STREAM_KEY, QUOTE_KEY_PREFIX, STREAM_COALESCE_MS, FEED_IDLE_TIMEOUT_MS, quoteFresh, type MarketQuote, type StreamStatus, type StreamUpdate } from '../../../packages/shared/src/realtime.js';
import type { Market } from '../../../packages/shared/src/index.js';
import type { Runtime } from './context.js';

export class MarketStream {
  private handle?: Awaited<ReturnType<Runtime['public']['startMarketFeed']>>;
  private tokens = new Map<string, Market>();
  private quotes = new Map<string, MarketQuote>();
  private pending = new Map<string, MarketQuote>();
  private dirtyMarkets = new Set<string>();
  private books = new DisplayBooks();
  private openedAt = 0;
  private status: StreamStatus = { connected: false, epoch: '', at: 0, lastEventAt: null, tokens: [], reason: 'Menghubungkan stream', events: 0, rejected: 0, exchangeLagMs: null };
  private timer: ReturnType<typeof setInterval>;
  private busy = false;
  private closed = false;
  private installing = false;
  private lastHealth = 0;
  private lastPolicy = 0;
  private enabled = false;
  private arbitrage = false;
  private prediction = false;
  private minimumEdge = 1;
  private forecasts = new Map<string, { lower: number; upper: number; expiresAt: string }>();
  private openMarkets = new Set<string>();
  constructor(private readonly runtime: Runtime) {
    this.timer = setInterval(() => { void this.flush().catch(() => { this.status.connected = false; this.status.reason = 'Publikasi harga atau antrean tidak tersedia'; logger.error('Market stream delivery unavailable'); }); }, STREAM_COALESCE_MS);
  }
  async install(markets: Market[]) {
    if (this.closed || this.installing || !markets.length) return;
    const held=(await pool.query('SELECT DISTINCT m.id,m.payload FROM markets m JOIN positions p ON p.market_id=m.id WHERE p.shares>0')).rows.map(row=>row.payload as Market);
    const next = new Map([...markets,...held].flatMap(market => [[market.yesToken, market], [market.noToken, market]] as [string, Market][]));
    const signature = [...next.keys()].sort().join(',');
    if (this.handle && signature === [...this.tokens.keys()].sort().join(',')) return;
    this.installing = true;
    try {
      const old = this.handle; this.handle = undefined;
      await old?.close().catch(() => undefined);
      this.tokens = next; this.quotes.clear(); this.pending.clear(); this.dirtyMarkets.clear(); this.books.clear(); this.openedAt = Date.now();
      await redis.del(...[...next.keys()].map(token => QUOTE_KEY_PREFIX + token));
      this.status = { connected: false, epoch: randomUUID(), at: Date.now(), lastEventAt: null, tokens: [...next.keys()], reason: 'Menyinkronkan harga', events: 0, rejected: 0, exchangeLagMs: null };
      await this.publish([]);
      const handle = await this.runtime.public.startMarketFeed([...next.keys()]); this.handle = handle;
      void this.receive(handle);
    } finally { this.installing = false; }
  }
  private async receive(handle: NonNullable<MarketStream['handle']>) {
    try {
      for await (const event of handle) {
        if (this.closed || this.handle !== handle) break;
        const now = Date.now();
        this.status.events++; this.status.connected = true; this.status.lastEventAt = now; this.status.reason = 'WebSocket Polymarket terhubung';
        const parsed = parseMarketQuotes(event, this.tokens, now);
        this.books.update(event, now);
        for (const quote of parsed) {
          const previous = this.quotes.get(quote.tokenId);
          if (quote.exchangeAt !== null && (quote.exchangeAt > now + 1000 || (previous?.exchangeAt !== null && previous?.exchangeAt !== undefined && quote.exchangeAt < previous.exchangeAt))) { this.status.rejected++; continue; }
          quote.depth = this.books.view(quote);
          this.quotes.set(quote.tokenId, quote); this.pending.set(quote.tokenId, quote);
          this.status.exchangeLagMs = quote.exchangeAt === null ? null : now - quote.exchangeAt;
          if (quoteFresh(quote)) this.dirtyMarkets.add(quote.marketId);
        }
      }
    } catch { this.status.reason = 'WebSocket terputus; menunggu koneksi ulang'; }
    finally {
      if (this.handle === handle) {
        this.handle = undefined; this.status.connected = false;
        this.quotes.clear(); this.pending.clear(); this.dirtyMarkets.clear();
        await this.publish([]).catch(() => undefined);
      }
    }
  }
  private async policy() {
    if (Date.now() - this.lastPolicy < 2000) return;
    const [control, { settings }, forecasts,positions] = await Promise.all([readControl(), readSettings(), pool.query("SELECT DISTINCT ON(market_id) market_id,payload FROM forecasts WHERE payload->>'abstain'='false' ORDER BY market_id,created_at DESC"),pool.query('SELECT DISTINCT market_id FROM positions WHERE shares>0')]);
    const risk = control.mode === 'paper' ? settings.paper : settings.live;
    this.enabled = control.state === 'running' && !!risk;
    this.arbitrage = settings.strategyEnabled.arbitrage; this.prediction = settings.strategyEnabled.prediction;
    this.minimumEdge = risk?.minimumEdge ?? 1;
    this.forecasts = new Map(forecasts.rows.map(row => [row.market_id, row.payload]));
    this.openMarkets = new Set(positions.rows.map(row=>row.market_id));
    this.lastPolicy = Date.now();
  }
  private candidate(market: Market) {
    const yes = this.quotes.get(market.yesToken), no = this.quotes.get(market.noToken);
    if (!quoteFresh(yes) || !quoteFresh(no) || !yes?.ask || !no?.ask) return false;
    if (this.arbitrage && Number(yes.ask) + Number(no.ask) < 1) return true;
    const forecast = this.forecasts.get(market.id);
    return this.prediction && forecast && Date.parse(forecast.expiresAt) > Date.now()
      && Math.max(forecast.lower - Number(yes.ask), 1 - forecast.upper - Number(no.ask)) >= this.minimumEdge;
  }
  private async publish(quotes: MarketQuote[]) {
    this.status.at = Date.now();
    const update: StreamUpdate = { status: { ...this.status }, quotes, publishedAt: Date.now() };
    const pipeline = redis.pipeline().set(MARKET_STREAM_KEY, JSON.stringify(this.status), 'EX', 30);
    for (const quote of quotes) pipeline.set(QUOTE_KEY_PREFIX + quote.tokenId, JSON.stringify(quote), 'EX', 60);
    pipeline.publish(MARKET_STREAM_CHANNEL, JSON.stringify(update));
    const results = await pipeline.exec();
    if (!results || results.some(([error]) => error)) throw new Error('Stream publication failed');
  }
  private async flush() {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      if (this.handle && Date.now() - (this.status.lastEventAt ?? this.openedAt) > FEED_IDLE_TIMEOUT_MS) {
        const handle = this.handle; this.handle = undefined; this.status.connected = false; this.status.reason = 'Tidak ada pesan pasar selama 15 detik';
        await handle.close().catch(() => undefined);
      }
      if (this.pending.size || Date.now() - this.status.at >= 1000) {
        const changes = [...this.pending.values()]; this.pending.clear(); await this.publish(changes);
      }
      if (Date.now() - this.lastHealth >= 1000) {
        await writeState('market-feed', { ...this.status, at: new Date(this.status.at).toISOString() }); this.lastHealth = Date.now();
      }
      await this.policy();
      if (!this.status.connected) { this.dirtyMarkets.clear(); return; }
      const dirty = [...this.dirtyMarkets]; this.dirtyMarkets.clear();
      for (const id of dirty) {
        const market = [...this.tokens.values()].find(market => market.id === id);
        if (!market) continue;
        if(this.openMarkets.has(id))await operationsQueue.add('position-risk',{marketId:id,receivedAt:Date.now()},{jobId:`position-risk-${id}`,priority:2,removeOnComplete:true,removeOnFail:true});
        if (!this.enabled || !this.candidate(market)) continue;
        const receivedAt = Math.max(this.quotes.get(market.yesToken)!.receivedAt, this.quotes.get(market.noToken)!.receivedAt);
        // A fixed job ID bounds queued/active work to one operation per market.
        await signalsQueue.add('consider', { marketId: id, receivedAt, epoch: this.status.epoch }, { jobId: `stream-${id}` });
      }
    } finally { this.busy = false; }
  }
  get active() { return !!this.handle; }
  async initialize() { await this.publish([]); }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await this.handle?.close().catch(() => undefined); this.handle = undefined;
    this.status.connected = false; this.status.reason = 'Worker berhenti';
    await this.publish([]).catch(() => undefined);
  }
}
