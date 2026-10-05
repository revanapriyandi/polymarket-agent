import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config.js';
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
export const queueConnection = { url: env.REDIS_URL, maxRetriesPerRequest: null };
export const operationsQueue = new Queue('polymarket-operations', { connection: queueConnection, defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 } });
export const researchQueue = new Queue('polymarket-research', { connection: queueConnection, defaultJobOptions: { attempts: 1, removeOnComplete: 200, removeOnFail: 200 } });
export const discoveryQueue = new Queue('polymarket-discovery', { connection: queueConnection, defaultJobOptions: { attempts: 1, removeOnComplete: 200, removeOnFail: 200 } });
export const signalsQueue = new Queue('polymarket-signals', { connection: queueConnection, defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
