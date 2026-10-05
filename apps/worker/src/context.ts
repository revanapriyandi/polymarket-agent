import { PolymarketGateway, createLiveGateway, ExchangeRequestControl, type ExchangeRequestState } from '../../../packages/trading/src/index.js';
import { env } from '../../../packages/core/src/config.js';
import { readState, writeState } from '../../../packages/core/src/state.js';
import type { ApiKeyCreds } from '@polymarket/client';
import { z } from 'zod';
import { loadManagedWallet, walletRpc } from '../../../packages/core/src/wallet.js';
const CredentialsSchema = z.object({ key: z.uuid(), secret: z.string().min(1), passphrase: z.string().min(1) });
export interface Runtime { public: PolymarketGateway; live: PolymarketGateway | null; walletAddress?: string; walletVersion?: number; requests?: ExchangeRequestControl }
export async function refreshManagedRuntime(runtime:Runtime) {
  if(env.POLYMARKET_PRIVATE_KEY)return;
  const row=await loadManagedWallet();
  if(!row||row.status!=='connected'||!row.wallet_address||!row.protected.credentials){runtime.live=null;return;}
  if(runtime.live&&runtime.walletVersion===row.version)return;
  const live=await createLiveGateway({privateKey:row.protected.privateKey,walletAddress:row.wallet_address,rpcUrl:walletRpc(),credentials:row.protected.credentials,builder:row.protected.builder},runtime.requests);
  runtime.live=live;runtime.walletAddress=row.wallet_address;runtime.walletVersion=row.version;
}
export async function createRuntime(): Promise<Runtime> {
  const requests = new ExchangeRequestControl(await readState<ExchangeRequestState>('exchange-request-control'), state => writeState('exchange-request-control', state));
  const runtime: Runtime = { public: new PolymarketGateway({ requestControl: requests }), live: null, requests, walletAddress:env.POLYMARKET_WALLET_ADDRESS };
  if (env.POLYMARKET_PRIVATE_KEY && env.POLYMARKET_WALLET_ADDRESS && env.POLYGON_RPC_URL && env.POLYMARKET_CLOB_API_KEY && env.POLYMARKET_CLOB_API_SECRET && env.POLYMARKET_CLOB_API_PASSPHRASE) {
    runtime.live = await createLiveGateway({ privateKey: env.POLYMARKET_PRIVATE_KEY as `0x${string}`, walletAddress: env.POLYMARKET_WALLET_ADDRESS as `0x${string}`, rpcUrl: env.POLYGON_RPC_URL, credentials: CredentialsSchema.parse({ key: env.POLYMARKET_CLOB_API_KEY, secret: env.POLYMARKET_CLOB_API_SECRET, passphrase: env.POLYMARKET_CLOB_API_PASSPHRASE }) as ApiKeyCreds, ...(env.POLYMARKET_RELAYER_API_KEY && env.POLYMARKET_RELAYER_API_KEY_ADDRESS ? {relayer:{key:env.POLYMARKET_RELAYER_API_KEY,address:env.POLYMARKET_RELAYER_API_KEY_ADDRESS as `0x${string}`}} : {}) }, requests);
  }
  if(!env.POLYMARKET_PRIVATE_KEY)await refreshManagedRuntime(runtime).catch(()=>writeState('wallet',{ready:false,checkedAt:new Date().toISOString(),reason:'Koneksi wallet server belum tersedia'}));
  return runtime;
}
