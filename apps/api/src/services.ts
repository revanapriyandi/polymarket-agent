import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ModeSchema } from '../../../packages/shared/src/index.js';
import { ServiceSettingsSchema } from '../../../packages/shared/src/services.js';
import { readServiceView, saveServices, probeSearch, searchNews, loadTrends } from '../../../packages/services/src/index.js';
import { readControl } from '../../../packages/core/src/state.js';
import { stepUp, HttpError } from './security.js';
import { discoveryQueue } from '../../../packages/core/src/queue.js';
export async function registerServices(app: FastifyInstance) {
  app.get('/api/services',()=>readServiceView());
  app.get('/api/trends',()=>loadTrends());
  app.put('/api/services',async req=>{
    await stepUp(req);const input=z.object({expectedVersion:z.number().int().nonnegative(),config:ServiceSettingsSchema,apiKey:z.string().max(4096).optional()}).parse(req.body);
    try {await saveServices(input.expectedVersion,input.config,input.apiKey);await discoveryQueue.add('refresh-trends',{});return readServiceView();}
    catch(error){if(error instanceof Error && /version|konfigurasi|changed|conflict/i.test(error.message))throw new HttpError(409,'Versi layanan berubah; muat ulang');throw error;}
  });
  app.post('/api/services/probe',async req=>{await stepUp(req);try{return await probeSearch(ModeSchema.parse((await readControl()).mode));}catch{throw new HttpError(400,'Tes pencarian gagal: periksa key, status aktif, harga kredit, dan anggaran riset');}});
  app.post('/api/services/search',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    await stepUp(req);
    const { query } = z.object({query:z.string().trim().min(1).max(1000).refine(value=>![...value].some(character=>character.charCodeAt(0)<32),'Control characters forbidden')}).strict().parse(req.body);
    try {return await searchNews(query,ModeSchema.parse((await readControl()).mode));}catch{throw new HttpError(400,'Pencarian gagal: periksa koneksi, key, dan anggaran riset. Biaya permintaan gagal mungkin tetap tercatat.');}
  });
}
