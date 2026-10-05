import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tradingAnalytics } from '../../../packages/core/src/analytics.js';

export async function registerAnalytics(app:FastifyInstance) {
  app.get('/api/analytics',async req=>tradingAnalytics(z.object({days:z.coerce.number().int().min(1).max(365).default(30)}).parse(req.query).days));
}
