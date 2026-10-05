import type { FastifyInstance } from 'fastify';
import { redis } from '../../../packages/core/src/queue.js';
import { dashboard } from '../../../packages/core/src/dashboard.js';
import { streamSnapshot } from '../../../packages/core/src/market-stream.js';
import { MARKET_STREAM_CHANNEL } from '../../../packages/shared/src/realtime.js';
import { owner, HttpError } from './security.js';
import type { ServerResponse } from 'node:http';

export async function registerEvents(app: FastifyInstance) {
  const clients=new Set<ServerResponse>();
  app.addHook('preClose',async()=>{for(const client of clients)client.end();});
  app.get('/api/market-stream', streamSnapshot);
  app.get('/api/market-stream/timings', async () => (await redis.lrange('polymarket:signal-timings', 0, 199)).map(value => JSON.parse(value)));
  app.get('/api/events', async (req, reply) => {
    const session = await owner(req);
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    clients.add(reply.raw);
    const subscriber = redis.duplicate();
    let busy = false, closed = false, lastAuth = Date.now(), expiresAt = new Date(session.session.expiresAt).getTime();
    const sendEvent = (event: string, payload: string) => {
      if (closed) return;
      if (Date.now() >= expiresAt || reply.raw.writableLength > 256 * 1024) { reply.raw.end(); return; }
      reply.raw.write(`event: ${event}\ndata: ${payload}\n\n`);
    };
    const snapshot = async () => {
      if (busy || closed) return; busy = true;
      try {
        if (Date.now() - lastAuth >= 30000) { const current = await owner(req); expiresAt = new Date(current.session.expiresAt).getTime(); lastAuth = Date.now(); }
        if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new HttpError(401, 'Sesi kadaluwarsa');
        sendEvent('snapshot', JSON.stringify(await dashboard()));
      } catch (error) {
        sendEvent('unavailable', '{}');
        if (error instanceof HttpError && error.status === 401) reply.raw.end();
      } finally { busy = false; }
    };
    // Quotes are pushed by the worker. This timer is only for account summaries.
    const interval = setInterval(() => void snapshot(), 5000);
    reply.raw.on('close', () => { closed = true; clients.delete(reply.raw); clearInterval(interval); subscriber.disconnect(); });
    subscriber.on('message', (_channel, message) => sendEvent('quotes', message));
    subscriber.on('error', () => sendEvent('market-unavailable', '{}'));
    subscriber.on('close', () => sendEvent('market-unavailable', '{}'));
    try {
      await subscriber.subscribe(MARKET_STREAM_CHANNEL);
      if (!closed) sendEvent('quotes', JSON.stringify(await streamSnapshot()));
      await snapshot();
    } catch { sendEvent('unavailable', '{}'); reply.raw.end(); }
  });
}
