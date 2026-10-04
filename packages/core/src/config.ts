import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  API_PORT: z.coerce.number().default(4100), API_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1), REDIS_URL: z.string().default('redis://127.0.0.1:6380'),
  BETTER_AUTH_SECRET: z.string().min(32), MASTER_KEY: z.string().refine(v => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY must encode 32 bytes'),
  OWNER_EMAIL: z.string().email(),
  POLYMARKET_PRIVATE_KEY: z.string().optional(), POLYMARKET_WALLET_ADDRESS: z.string().optional(), POLYMARKET_RELAYER_API_KEY: z.string().optional(), POLYGON_RPC_URL: z.string().url().optional(),
  POLYMARKET_CLOB_API_KEY: z.string().optional(), POLYMARKET_CLOB_API_SECRET: z.string().optional(), POLYMARKET_CLOB_API_PASSPHRASE: z.string().optional(),
  POLYMARKET_RELAYER_API_KEY_ADDRESS: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(), TAVILY_COST_PER_CREDIT_USD: z.coerce.number().nonnegative().default(.008),
  AI_ENDPOINT_ALLOWLIST: z.string().default(''), ENABLE_LIVE_EXECUTION: z.enum(['true', 'false']).default('false'),
});
export const env = schema.parse(process.env);
