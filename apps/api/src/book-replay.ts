import type { FastifyInstance } from 'fastify';
import { BookReplayInputSchema, bookSnapshotSummary, replayArbitrage } from '../../../packages/core/src/book-replay.js';
import { stepUp } from './security.js';

export async function registerBookReplay(app: FastifyInstance) {
  app.get('/api/evaluation/books', () => bookSnapshotSummary());
  app.post('/api/evaluation/books/replay', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async request => {
    await stepUp(request);
    return replayArbitrage(BookReplayInputSchema.parse(request.body));
  });
}
