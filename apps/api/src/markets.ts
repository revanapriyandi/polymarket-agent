import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../../packages/db/src/index.js';
import { redis } from '../../../packages/core/src/queue.js';
import { PolymarketGateway } from '../../../packages/trading/src/index.js';
import type { Market } from '../../../packages/shared/src/index.js';
import { HttpError } from './security.js';

const gateway = new PolymarketGateway();
export async function storedMarket(id: string): Promise<Market> {
  const row = (await pool.query('SELECT payload FROM markets WHERE id=$1', [id])).rows[0];
  if (!row) throw new HttpError(404, 'Pasar belum tersedia di universe worker');
  return row.payload;
}
export async function registerMarkets(app: FastifyInstance) {
  app.get('/api/markets', async req => {
    const { search } = z.object({ search: z.string().max(200).default('') }).parse(req.query);
    return (await pool.query("SELECT payload FROM markets WHERE (payload->>'question' ILIKE $1 OR id=$2) AND payload->>'active'='true' AND payload->>'closed'='false' AND payload->>'acceptingOrders'='true' AND NULLIF(payload->>'endDate','')::timestamptz>now() ORDER BY (payload->>'liquidity')::numeric DESC LIMIT 200", [`%${search}%`, search])).rows.map(row => row.payload);
  });
  app.get('/api/markets/:id', async req => storedMarket(z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params).id));
  app.get('/api/markets/:id/book', async req => {
    const market = await storedMarket(z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params).id);
    const { outcome } = z.object({ outcome: z.enum(['YES', 'NO']).default('YES') }).parse(req.query);
    const token = outcome === 'YES' ? market.yesToken : market.noToken;
    return { ...await gateway.getBook(token), source: 'Polymarket REST', retrievedAt: new Date().toISOString() };
  });
  app.get('/api/markets/:id/chart', async req => {
    const market = await storedMarket(z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params).id);
    const { outcome, range } = z.object({ outcome: z.enum(['YES','NO']).default('YES'), range: z.enum(['1D','7D','30D']).default('7D') }).parse(req.query);
    const key = `polymarket:history:${market.id}:${outcome}:${range}`;
    const cached = await redis.get(key); if (cached) return JSON.parse(cached);
    const days = range === '1D' ? 1 : range === '7D' ? 7 : 30;
    const data = await gateway.getHistory(outcome === 'YES' ? market.yesToken : market.noToken, days, range === '1D' ? 300 : 3600);
    const result = { points: data.map(point => ({ time: Math.floor(Number(point.timestamp) / 1000), value: Number(point.price) })), source: 'Polymarket Data API v2', kind: 'price-samples', bucketSeconds: range === '1D' ? 300 : 3600, retrievedAt: new Date().toISOString() };
    await redis.set(key, JSON.stringify(result), 'EX', 30); return result;
  });
}
