import { PolymarketGateway, createLiveGateway, ExchangeRequestControl, type ExchangeRequestState } from '../../../packages/trading/src/index.js';
import { env } from '../../../packages/core/src/config.js';
import { readState, writeState } from '../../../packages/core/src/state.js';
import type { ApiKeyCreds } from '@polymarket/client';
import { z } from 'zod';
const CredentialsSchema = z.object({ key: z.uuid(), secret: z.string().min(1), passphrase: z.string().min(1) });
export interface Runtime { public: PolymarketGateway; live: PolymarketGateway | null }
export async function createRuntime(): Promise<Runtime> {
  const requests = new ExchangeRequestControl(await readState<ExchangeRequestState>('exchange-request-control'), state => writeState('exchange-request-control', state));
  const runtime: Runtime = { public: new PolymarketGateway({ requestControl: requests }), live: null };
  if (env.POLYMARKET_PRIVATE_KEY && env.POLYMARKET_WALLET_ADDRESS && env.POLYGON_RPC_URL && env.POLYMARKET_CLOB_API_KEY && env.POLYMARKET_CLOB_API_SECRET && env.POLYMARKET_CLOB_API_PASSPHRASE) {
    runtime.live = await createLiveGateway({ privateKey: env.POLYMARKET_PRIVATE_KEY as `0x${string}`, walletAddress: env.POLYMARKET_WALLET_ADDRESS as `0x${string}`, rpcUrl: env.POLYGON_RPC_URL, credentials: CredentialsSchema.parse({ key: env.POLYMARKET_CLOB_API_KEY, secret: env.POLYMARKET_CLOB_API_SECRET, passphrase: env.POLYMARKET_CLOB_API_PASSPHRASE }) as ApiKeyCreds, ...(env.POLYMARKET_RELAYER_API_KEY && env.POLYMARKET_RELAYER_API_KEY_ADDRESS ? {relayer:{key:env.POLYMARKET_RELAYER_API_KEY,address:env.POLYMARKET_RELAYER_API_KEY_ADDRESS as `0x${string}`}} : {}) }, requests);
  }
  return runtime;
}
