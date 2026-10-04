import Fastify, { type FastifyBaseLogger } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { auth } from '../../../packages/core/src/auth.js';
import { env } from '../../../packages/core/src/config.js';
import { pool } from '../../../packages/db/src/index.js';
import { redis, operationsQueue, researchQueue, discoveryQueue } from '../../../packages/core/src/queue.js';
import { logger } from '../../../packages/core/src/logger.js';
import { dashboard } from '../../../packages/core/src/dashboard.js';
import { owner, HttpError, requestHeaders } from './security.js';
import { registerRoutes } from './routes.js';
import { registerServices } from './services.js';
const app = Fastify({ loggerInstance: logger as FastifyBaseLogger, bodyLimit: 128 * 1024, trustProxy: env.NODE_ENV === 'production' ? '127.0.0.1' : false, requestTimeout: 120000 });
await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } } });
await app.register(rateLimit, { max: 180, timeWindow: '1 minute', redis, keyGenerator: req => req.ip });
app.setErrorHandler((error, req, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
  if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
  const known:Record<string,{status:number;message:string}> = {
    'Provider tidak ditemukan':{status:404,message:'Provider tidak ditemukan'},
    'Harga input/output token wajib diisi untuk membatasi biaya':{status:400,message:'Isi harga input dan output token sebelum melakukan probe'},
    'Konfigurasi provider berubah':{status:409,message:'Konfigurasi provider berubah; muat ulang'},
    'Anggaran provider tidak cukup untuk reservasi biaya maksimum':{status:409,message:'Budget provider tidak cukup untuk reservasi biaya maksimum'},
    'Batas concurrency provider tercapai':{status:429,message:'Batas concurrency provider tercapai; coba lagi setelah panggilan selesai'},
    'Batas pemanggilan per menit tercapai':{status:429,message:'Batas pemanggilan per menit tercapai; tunggu sebelum mencoba lagi'}
  };
  const safe = error instanceof Error ? known[error.message] : undefined;
  if(safe) return reply.code(safe.status).send({error:safe.message});
  if(typeof error === 'object' && error!==null && 'statusCode' in error){const status=Number(error.statusCode);if([400,413,415,429].includes(status))return reply.code(status).send({error:status===429?'Terlalu banyak permintaan; coba lagi nanti':'Format atau ukuran permintaan tidak valid'});}
  logger.error({ errorName: error instanceof Error ? error.name : 'Error', route: req.routeOptions.url }, 'Request failed');
  return reply.code(500).send({ error: 'Operasi gagal. Periksa status layanan dan audit; rahasia tidak ditampilkan.' });
});
app.addHook('onRequest', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/') && req.headers.origin !== env.APP_ORIGIN) throw new HttpError(403, 'Origin tidak diizinkan');
  if (req.url.startsWith('/api/') && !req.url.startsWith('/api/auth/') && req.url !== '/api/health') await owner(req);
});
app.get('/api/health', async (_req, reply) => { try { await pool.query('SELECT 1'); await redis.ping(); return { status: 'ok', at: new Date().toISOString() }; } catch { return reply.code(503).send({ status: 'unavailable' }); } });
app.route({ method: ['GET','POST'], url: '/api/auth/*', handler: async (req, reply) => {
  const response = await auth.handler(new Request(new URL(req.url, env.APP_ORIGIN), { method: req.method, headers: requestHeaders(req), ...(req.method !== 'GET' ? { body: JSON.stringify(req.body ?? {}) } : {}) }));
  reply.status(response.status);
  for (const [key, value] of response.headers) if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
  if (response.headers.getSetCookie().length) reply.header('set-cookie', response.headers.getSetCookie());
  return reply.send(await response.text());
} });
await registerRoutes(app);
await registerServices(app);
app.get('/api/events', async (req, reply) => {
  reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let busy = false, closed = false, lastAuth = 0, expiresAt = 0;
  const send = async () => {
    if (busy || closed) return; busy = true;
    try {
      if(Date.now()>=expiresAt || Date.now()-lastAuth>=30000){const session=await owner(req);expiresAt=new Date(session.session.expiresAt).getTime();lastAuth=Date.now();}
      if(!Number.isFinite(expiresAt)||Date.now()>=expiresAt)throw new HttpError(401,'Sesi kadaluwarsa');
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(await dashboard())}\n\n`);
    } catch(error) {
      reply.raw.write('event: unavailable\ndata: {}\n\n');
      if(error instanceof HttpError && error.status===401) {closed=true;reply.raw.end();}
    } finally { busy=false; }
  };
  const interval = setInterval(() => void send(), 1500);
  reply.raw.on('close', () => { closed = true; clearInterval(interval); }); await send();
});
if (existsSync(resolve('dist/web/index.html'))) { await app.register(staticFiles, { root: resolve('dist/web') }); app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Endpoint tidak ditemukan' }) : reply.sendFile('index.html')); }
await app.listen({ host: env.API_HOST, port: env.API_PORT });
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, () => { void (async () => { await app.close(); await operationsQueue.close(); await researchQueue.close(); await discoveryQueue.close(); await redis.quit(); await pool.end(); process.exit(0); })(); });
