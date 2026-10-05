import { createSecureClient, forkEnvironmentConfig, production, relayerApiKey, type ApiKeyCreds, type Signer } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { builderApiKey, type BuilderApiKeyCreds } from '@polymarket/client/node';
import { createPublicClient, http, hashTypedData, type Address, type TypedDataDomain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { GatewayError } from './errors';
import { PolymarketGateway } from './gateway';
import type { ExchangeRequestControl } from './request-control';

export interface LiveWalletConfig { privateKey: `0x${string}`; walletAddress: Address; rpcUrl: string; credentials: ApiKeyCreds; relayer?: { key: string; address: Address }; builder?: BuilderApiKeyCreds }
export async function createLiveGateway(config: LiveWalletConfig, requestControl?: ExchangeRequestControl) {
  const account = privateKeyToAccount(config.privateKey);
  const rpc = createPublicClient({ chain: polygon, transport: http(config.rpcUrl) });
  if (config.walletAddress.toLowerCase() !== account.address.toLowerCase()) {
    const code = await rpc.getCode({ address: config.walletAddress });
    if (!code || code === '0x') throw new GatewayError('WALLET_NOT_DEPLOYED', 'Deploy the account wallet externally before connecting; automatic deployment is disabled');
  }
  const environment = forkEnvironmentConfig({ name: 'configured-production-rpc', rpc: config.rpcUrl }, production);
  const underlying=privateKey(config.privateKey, { chain: polygon, transport: http(config.rpcUrl) });
  const hashes=new Map<string,`0x${string}`>();
  const exchanges=new Map<string,string>();
  const signer: Signer = { ...underlying, getAddress:()=>underlying.getAddress(), sendTransaction:request=>underlying.sendTransaction(request), signTypedData:async payload=>{
    // Capture the SDK's public signing payload so domains and protocol versions remain SDK-owned.
    const message=payload.primaryType==='Order' ? payload.message : payload.primaryType==='TypedDataSign' ? payload.message.contents : null;
    if(message && typeof message==='object' && 'salt' in message && payload.types.Order) {
      if(payload.domain.verifyingContract) exchanges.set(String(message.salt),payload.domain.verifyingContract);
      hashes.set(String(message.salt),hashTypedData({domain:payload.domain as TypedDataDomain,types:{Order:payload.types.Order},primaryType:'Order',message:message as Record<string,unknown>}));
    }
    return underlying.signTypedData(payload);
  } };
  const apiKey=config.builder ? builderApiKey(config.builder) : config.relayer ? relayerApiKey(config.relayer) : undefined;
  const secureClient = await createSecureClient({ environment, apiKey, wallet: config.walletAddress, signer, credentials: config.credentials });
  return new PolymarketGateway({ secureClient, requestControl, walletAddress: config.walletAddress, rpcUrl: config.rpcUrl, gaslessConfigured:!!(config.relayer || config.builder) && config.walletAddress.toLowerCase() !== account.address.toLowerCase(), orderHash:order=>hashes.get(order.salt) ?? null, exchangeAddress:order=>exchanges.get(order.salt) ?? null, publicOptions: { environment }, heartbeat: { signerAddress: account.address, credentials: secureClient.credentials } });
}
