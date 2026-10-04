import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../../packages/db/src/index.js';
import { replayCandidate } from '../../../packages/core/src/replay.js';
import { owner, stepUp } from './security.js';
export async function registerEvaluation(app: FastifyInstance) {
  app.get('/api/evaluation/profiles', async req => {
    await owner(req);
    return (await pool.query('SELECT profile_version "profileVersion",count(DISTINCT market_id)::integer events FROM forecasts WHERE outcome IN (0,1) GROUP BY profile_version ORDER BY max(created_at) DESC LIMIT 100')).rows;
  });
  app.post('/api/evaluation/replay', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async req => {
    await stepUp(req);
    const input = z.object({ profileVersion: z.string().regex(/^[a-f0-9]{20}$/), minimumEdge: z.number().min(0.01).max(1), lookbackDays: z.number().int().min(7).max(365), limit: z.number().int().min(1).max(2000) }).strict().parse(req.body);
    return replayCandidate(input);
  });
}
