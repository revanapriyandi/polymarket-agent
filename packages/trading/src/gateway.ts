import { createHash, createHmac } from 'node:crypto';
import { createPublicClient, AssetType, OrderSide, OrderType, type SecureClient, type SignedOrder, type Market as SdkMarket, type ApiKeyCreds, type Paginated, type PublicClientOptions } from '@polymarket/client';
import { fetchMarketInfo, fetchBalanceAllowance, fetchTransaction } from '@polymarket/client/actions';
import { createPublicClient as createRpcClient, http, type Hash, type Address } from 'viem';
import { polygon } from 'viem/chains';
import { readOrderSettlement } from './settlement';
import type { Market, OrderBook, OrderIntent } from '../../shared/src/index';
import { D, roundShares, feeFor } from './math';
import { GatewayError } from './errors';
import { ExchangeRequestControl } from './request-control';

export interface PreparedOrder { intent: OrderIntent; signed: SignedOrder; hash: string; exchangeOrderHash?: string | null; exchangeAddress?: string | null; preparedAt: string; authorizationExpiresAt?: string }
export interface ReconciledFill { tradeId: string; orderId: string; tokenId: string; shares: string; price: string; side: string; status: string; confirmed: boolean; transactionHash: string | null; actualFeeUsd: string|null; feeRateBps: string | null }
export interface GatewayOptions { secureClient?: SecureClient; walletAddress?: string; rpcUrl?: string; gaslessConfigured?: boolean; orderHash?: (order:SignedOrder)=>string|null; exchangeAddress?: (order:SignedOrder)=>string|null; publicOptions?: PublicClientOptions; requestControl?: ExchangeRequestControl; heartbeat?: { signerAddress: string; credentials: ApiKeyCreds } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
function finalResolution(market: SdkMarket) {
  const prices = [market.outcomes.yes.price, market.outcomes.no.price];
  return market.state.closed === true && market.resolution.umaResolutionStatus?.toLowerCase() === 'resolved'
    && prices.every(p => p !== undefined && p !== null && D(p).gte(0) && D(p).lte(1))
    && prices.reduce((sum, p) => sum.plus(p ?? '0'), D(0)).eq(1);
}
async function collect<T>(pages: Paginated<T[]>, maximum = 10000): Promise<T[]> {
  const result: T[] = [];
  for await (const page of pages) { result.push(...page.items); if (result.length >= maximum) { if (page.nextCursor) throw new GatewayError('PAGINATION_LIMIT', 'Account snapshot exceeds safe pagination limit'); break; } }
  return result;
}
export class PolymarketGateway {
  readonly publicClient;
  private heartbeatId = '';
  private heartbeatAt = 0;
  private readonly submitted = new Set<string>();
  private readonly requests: ExchangeRequestControl;
  constructor(private readonly options: GatewayOptions = {}) { this.publicClient = createPublicClient(options.publicOptions); this.requests = options.requestControl ?? new ExchangeRequestControl(); }
  private secure() { if (!this.options.secureClient) throw new GatewayError('WALLET_UNCONFIGURED', 'Authenticated wallet client is not configured'); return this.options.secureClient; }
  private async normalize(raw: SdkMarket): Promise<Market> {
    const yesToken = raw.outcomes.yes.tokenId ?? raw.outcomes.yes.positionId;
    const noToken = raw.outcomes.no.tokenId ?? raw.outcomes.no.positionId;
    if (!raw.conditionId || !yesToken || !noToken || raw.outcomes.yes.label.toLowerCase() !== 'yes' || raw.outcomes.no.label.toLowerCase() !== 'no') throw new GatewayError('UNSUPPORTED_MARKET', 'Only standard binary Yes/No markets are supported');
    const [info, book] = await Promise.all([this.requests.run('read', () => fetchMarketInfo(this.publicClient, { conditionId: raw.conditionId! })), this.getBook(yesToken)]);
    if (info.negRisk || raw.sports.gameId || raw.sports.sportsMarketType) throw new GatewayError('UNSUPPORTED_MARKET', 'Negative risk and sports markets are excluded');
    const resolution = raw.resolution;
    return { id: raw.id, conditionId: raw.conditionId, eventId: raw.events[0]?.id ?? raw.id, slug: raw.slug ?? '', question: raw.question ?? '', description: raw.description ?? '', resolutionSource: resolution.source ?? '', rulesHash: hash({ description: raw.description, resolution }), yesToken, noToken, endDate: raw.state.endDate ?? '', active: raw.state.active === true, closed: raw.state.closed === true, acceptingOrders: raw.state.acceptingOrders === true, negRisk: info.negRisk, liquidity: raw.metrics.liquidity ?? '0', volume: raw.metrics.volume ?? '0', tickSize: book.tickSize, minOrderSize: book.minOrderSize, category: raw.category ?? '', observedAt: now(), resolved: finalResolution(raw), outcomePrices: [raw.outcomes.yes.price ?? '0', raw.outcomes.no.price ?? '0'], fee: { rate: String(info.feeInfo.rate), exponent: info.feeInfo.exponent, takerOnly: true } };
  }
  async discoverMarkets(limit = 40): Promise<Market[]> {
    return this.requests.run('read', async () => {
    const result: Market[] = [], start = new Date(Date.now() + 86400000), end = new Date(Date.now() + 30 * 86400000);
    let inspected = 0;
    for await (const page of this.publicClient.listMarkets({ closed: false, endDateMin: start, endDateMax: end, pageSize: 100, order: 'liquidity', ascending: false })) {
      for (const raw of page.items) { if (++inspected > 500) return result; if (!raw.state.active || !raw.state.acceptingOrders || raw.state.negRisk || raw.sports.gameId || raw.sports.sportsMarketType) continue; try { result.push(await this.normalize(raw)); } catch (error) { if (!(error instanceof GatewayError && error.code === 'UNSUPPORTED_MARKET')) throw error; } if (result.length >= Math.min(200, Math.max(1, limit))) return result; }
    }
    return result;
    }, false, 120000);
  }
  async getMarket(id: string) { return this.normalize(await this.requests.run('read', () => this.publicClient.fetchMarket({ id }))); }
  async getResolution(id: string) {
    const market = await this.requests.run('read', () => this.publicClient.fetchMarket({ id }));
    return { id: market.id, conditionId: market.conditionId, closed: market.state.closed === true, resolutionStatus: market.resolution.umaResolutionStatus, outcomePrices: [market.outcomes.yes.price,market.outcomes.no.price] as const, resolved: finalResolution(market), observedAt: now() };
  }
  async getBook(tokenId: string): Promise<OrderBook> {
    const book = await this.requests.run('read', () => this.publicClient.fetchOrderBook({ assetId: tokenId }));
    if (book.negRisk) throw new GatewayError('UNSUPPORTED_MARKET', 'Negative risk book is excluded');
    return { tokenId, bids: [...book.bids].sort((a,b) => D(b.price).cmp(a.price)), asks: [...book.asks].sort((a,b) => D(a.price).cmp(b.price)), tickSize: String(book.tickSize), minOrderSize: book.minOrderSize, hash: book.hash, observedAt: book.timestamp ? new Date(book.timestamp).toISOString() : now() };
  }
  getHistory(tokenId: string) { return this.requests.run('read', () => collect(this.publicClient.listPriceHistory({ assetId: tokenId, start: new Date(Date.now() - 14 * 86400000), bucketSeconds: 3600 }))); }
  async getGeoblock() { const response = await fetch('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new GatewayError('GEOBLOCK_UNKNOWN', 'Cannot verify geographic trading eligibility'); const data: unknown = await response.json(); if (!data || typeof data !== 'object' || !('blocked' in data) || typeof data.blocked !== 'boolean') throw new GatewayError('GEOBLOCK_UNKNOWN', 'Invalid geographic eligibility response'); return data as { blocked: boolean; country?: string; region?: string }; }
  async walletReadiness(address: string) { const [geoblock, approvals] = await Promise.all([this.getGeoblock(), this.requests.run('read', () => this.publicClient.fetchTradingApprovalsState({ user: address }))]); return { ready: !geoblock.blocked && approvals.isFullyApproved && !!this.options.secureClient, geoblock, approvals, authenticated: !!this.options.secureClient, heartbeatConfigured: !!this.options.heartbeat, gaslessConfigured: this.options.gaslessConfigured === true }; }
  async prepareOrder(intent: OrderIntent): Promise<PreparedOrder> {
    if (intent.mode !== 'live') throw new GatewayError('PAPER_ONLY', 'Paper intents cannot reach live exchange');
    const client = this.secure(), [geo, market, book, closedOnly] = await Promise.all([this.getGeoblock(), this.getMarket(intent.marketId), this.getBook(intent.tokenId), this.requests.run('read', () => client.fetchClosedOnlyMode())]);
    if (geo.blocked) throw new GatewayError('GEO_BLOCKED', 'Trading unavailable in this location');
    if (closedOnly && intent.strategy !== 'exit') throw new GatewayError('CLOSED_ONLY', 'Only position reduction is permitted');
    if (!market.active || market.closed || !market.acceptingOrders || market.rulesHash !== intent.rulesHash || market.conditionId !== intent.conditionId || ![market.yesToken,market.noToken].includes(intent.tokenId)) throw new GatewayError('MARKET_CHANGED', 'Market context changed; require a new decision');
    const shares = roundShares(intent.shares), price = D(intent.limitPrice);
    const bookAt = Date.parse(book.observedAt);
    if (!Number.isFinite(bookAt) || bookAt > Date.now() + 1000 || Date.now() - bookAt > 10000) throw new GatewayError('STALE_BOOK', 'Fresh book required immediately before signing');
    if (!price.isFinite() || price.lte(0) || price.gte(1) || !price.mod(book.tickSize).eq(0) || D(shares).lt(book.minOrderSize) || shares !== D(intent.shares).toFixed(2)) throw new GatewayError('INVALID_ORDER', 'Price must match tick and shares must satisfy minimum and two-decimal precision');
    if (intent.postOnly && !['GTC','GTD'].includes(intent.orderType)) throw new GatewayError('INVALID_ORDER', 'Post-only requires GTC or GTD');
    if (intent.orderType === 'GTD' && (!intent.expiration || intent.expiration < Math.floor(Date.now()/1000)+180)) throw new GatewayError('INVALID_ORDER', 'GTD expiration must be at least three minutes ahead');
    if (intent.side === 'BUY' && price.mul(shares).plus(feeFor(market,intent.limitPrice,shares)).gt(intent.maxCost)) throw new GatewayError('MAX_COST', 'Order exceeds approved maximum cost');
    if (['GTC','GTD'].includes(intent.orderType) && Date.now()-this.heartbeatAt > 7000) throw new GatewayError('HEARTBEAT_REQUIRED', 'Accepted account order heartbeat is required before resting orders');
    const signed = await this.requests.run('order', () => client.createLimitOrder({ assetId: intent.tokenId, price: intent.limitPrice, size: shares, side: intent.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL, postOnly: intent.postOnly, ...(intent.orderType === 'GTD' ? { expiration: intent.expiration } : {}) }), intent.postOnly);
    signed.orderType = OrderType[intent.orderType];
    return { intent, signed, hash: hash(signed), exchangeOrderHash:this.options.orderHash?.(signed) ?? null, exchangeAddress:this.options.exchangeAddress?.(signed) ?? null, preparedAt: now() };
  }
  async submitPrepared(prepared: PreparedOrder) {
    const authorizedUntil = Date.parse(prepared.authorizationExpiresAt ?? '');
    if (!Number.isFinite(authorizedUntil) || authorizedUntil <= Date.now()) throw new GatewayError('PERMIT_EXPIRED', 'Fresh persisted risk authorization is required');
    if (hash(prepared.signed) !== prepared.hash || Date.now()-Date.parse(prepared.preparedAt)>15000) throw new GatewayError('STALE_PREPARED_ORDER', 'Signed payload changed or expired');
    if (this.submitted.has(prepared.hash)) throw new GatewayError('RECONCILE_REQUIRED', 'Order already attempted; reconcile instead of resubmitting', true);
    if ((await this.getGeoblock()).blocked) throw new GatewayError('GEO_BLOCKED', 'Trading unavailable in this location');
    if (['GTC','GTD'].includes(prepared.intent.orderType) && Date.now()-this.heartbeatAt > 7000) throw new GatewayError('HEARTBEAT_REQUIRED', 'Order heartbeat expired before submission');
    if (authorizedUntil <= Date.now()) throw new GatewayError('PERMIT_EXPIRED', 'Risk permit expired during final preflight');
    this.submitted.add(prepared.hash);
    return this.requests.run('order', async () => {
      const response = await this.secure().postOrder(prepared.signed);
      if (!response.ok && response.code === 'post_only_mode') throw new GatewayError('POST_ONLY_REJECTED', 'Exchange rejected non-maker order during post-only mode', false, false, 120);
      return response;
    }, prepared.intent.postOnly);
  }
  getOrders() { return this.requests.run('read', () => collect(this.secure().listOpenOrders())); }
  getOrder(orderId: string) { return this.requests.run('read', () => this.secure().fetchOrder({ orderId })); }
  getTrades() { return this.requests.run('read', () => collect(this.secure().listAccountTrades())); }
  getPositions(address = this.options.walletAddress) { if (!address) throw new GatewayError('WALLET_UNCONFIGURED', 'Wallet address is required'); return this.requests.run('read', () => collect(this.publicClient.listPositions({ user: address, pageSize: 100 }))); }
  getBalances(tokenId?: string) { return this.requests.run('read', () => fetchBalanceAllowance(this.secure(), { assetType: tokenId ? AssetType.CONDITIONAL : AssetType.COLLATERAL, ...(tokenId ? { assetId: tokenId } : {}) })); }
  async reconcile() { const [orders,trades,positions,balances] = await Promise.all([this.getOrders(),this.getTrades(),this.getPositions(),this.getBalances()]); return { orders,trades,positions,balances, observedAt: now() }; }
  async normalizedReconcile(orderContexts: {orderId:string;exchangeAddress:string}[] = []) {
    const snapshot = await this.reconcile();
    const wallet = this.options.walletAddress?.toLowerCase();
    const fills: ReconciledFill[] = [];
    for (const trade of snapshot.trades) {
      const state = { tradeId: trade.id, status: trade.status, confirmed: trade.status.toUpperCase() === 'CONFIRMED', transactionHash: trade.transactionHash ?? null, actualFeeUsd: null };
      if (trade.traderSide === 'TAKER') fills.push({ ...state, orderId: trade.takerOrderId, tokenId: trade.assetId, shares: trade.size, price: trade.price, side: trade.side, feeRateBps: trade.feeRateBps });
      else {
        if (!wallet) throw new GatewayError('WALLET_UNCONFIGURED','Wallet address required to identify maker-specific fills');
        for (const maker of trade.makerOrders) if (maker.makerAddress.toLowerCase() === wallet) fills.push({ ...state, orderId: maker.orderId, tokenId: maker.assetId, shares: maker.matchedAmount, price: maker.price, side: maker.side, feeRateBps: maker.feeRateBps });
      }
    }
        for(const fill of fills) {
      const context=orderContexts.find(item=>item.orderId.toLowerCase()===fill.orderId.toLowerCase());
      const siblings=fills.filter(item=>item.orderId===fill.orderId && item.transactionHash===fill.transactionHash);
      if(!context || !fill.confirmed || !fill.transactionHash || !this.options.rpcUrl || !wallet || siblings.length!==1) continue;
      const evidence=await readOrderSettlement(this.options.rpcUrl,fill.transactionHash as Hash,fill.orderId as Hash,context.exchangeAddress as Address,wallet as Address);
      const matched=evidence.fills.filter(item=>item.tokenId===fill.tokenId && item.side===fill.side);
      if(matched.length && matched.reduce((sum,item)=>sum.plus(item.shares),D(0)).eq(fill.shares)) fill.actualFeeUsd=matched.reduce((sum,item)=>sum.plus(item.actualFeeUsd),D(0)).toFixed();
    }
    return { ...snapshot, fills };
  }
  async getTransactionReceipt(transactionHash: string) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) throw new GatewayError('INVALID_TRANSACTION','Invalid transaction hash');
    if (!this.options.rpcUrl) throw new GatewayError('RPC_UNCONFIGURED','Polygon RPC is required for settlement verification');
    const rpc=createRpcClient({chain:polygon,transport:http(this.options.rpcUrl)});
    try { const receipt=await rpc.getTransactionReceipt({hash:transactionHash as Hash}); const head=await rpc.getBlockNumber(); return {transactionHash:receipt.transactionHash,status:receipt.status,blockNumber:receipt.blockNumber.toString(),confirmations:(head-receipt.blockNumber+1n).toString(),gasCostWei:(receipt.gasUsed*receipt.effectiveGasPrice).toString(),observedAt:now()}; }
    catch(error) { if(error instanceof Error && error.name==='TransactionReceiptNotFoundError') return {transactionHash,status:'pending' as const,observedAt:now()}; throw error; }
  }
  getOrderSettlement(transactionHash: string, orderId: string, exchangeAddress: string) {
    if(!this.options.rpcUrl || !this.options.walletAddress) throw new GatewayError('RPC_UNCONFIGURED','Configured RPC and wallet required for exact fee accounting');
    if(!/^0x[a-fA-F0-9]{64}$/.test(transactionHash) || !/^0x[a-fA-F0-9]{64}$/.test(orderId) || !/^0x[a-fA-F0-9]{40}$/.test(exchangeAddress)) throw new GatewayError('INVALID_SETTLEMENT_CONTEXT','Invalid persisted order settlement identity');
    return readOrderSettlement(this.options.rpcUrl,transactionHash as Hash,orderId as Hash,exchangeAddress as Address,this.options.walletAddress as Address);
  }
  getRelayerTransaction(transactionId: string) { return this.requests.run('read', () => fetchTransaction(this.secure(), { transactionId })); }
  startMarketFeed(tokenIds: string[]) { return this.publicClient.subscribe([{ topic: 'market', assetIds: tokenIds, customFeatureEnabled: true }]); }
  startUserFeed(conditionIds: string[] = []) { return this.secure().subscribe([{ topic: 'user', markets: conditionIds }]); }
  cancel(orderId: string) { return this.requests.run('cancel', () => this.secure().cancelOrder({ orderId })); }
  cancelAll() { return this.requests.run('cancel', () => this.secure().cancelAll()); }
  merge(conditionId: string, shares: string) { const value = D(shares); if (!value.isFinite() || value.lte(0) || value.decimalPlaces()>6) throw new GatewayError('INVALID_AMOUNT','Merge shares must be positive with at most six decimals'); return this.requests.run('settlement', () => this.secure().mergePositions({ conditionId, amount: BigInt(value.mul(1000000).toFixed(0)) })); }
  redeem(conditionId: string) { return this.requests.run('settlement', () => this.secure().redeemPositions({ conditionId })); }
  async orderHeartbeat() {
    return this.requests.run('heartbeat', async () => {
    const config = this.options.heartbeat; if (!config) throw new GatewayError('HEARTBEAT_UNCONFIGURED', 'Order heartbeat credentials are not configured');
    const path='/v1/heartbeats', body=JSON.stringify({ heartbeat_id: this.heartbeatId }), timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',Buffer.from(config.credentials.secret,'base64')).update(timestamp+'POST'+path+body).digest('base64').replace(/\+/g,'-').replace(/\//g,'_');
    const response=await fetch('https://clob.polymarket.com'+path,{method:'POST',body,headers:{'Content-Type':'application/json',POLY_ADDRESS:config.signerAddress,POLY_API_KEY:config.credentials.key,POLY_PASSPHRASE:config.credentials.passphrase,POLY_SIGNATURE:signature,POLY_TIMESTAMP:timestamp},signal:AbortSignal.timeout(4000)});
    const data: unknown=await response.json();
    if (response.status === 429) {
      const rawDelay = response.headers.get('retry-after');
      const delay = rawDelay === null ? undefined : /^\d+(\.\d+)?$/.test(rawDelay) ? Number(rawDelay) : (Date.parse(rawDelay) - Date.now()) / 1000;
      throw new GatewayError('RATE_LIMIT', 'Heartbeat rate limit', false, false, delay !== undefined && Number.isFinite(delay) ? Math.max(0, delay) : undefined);
    }
    if (data && typeof data==='object' && 'heartbeat_id' in data && typeof data.heartbeat_id==='string') { this.heartbeatId=data.heartbeat_id; if(response.ok) {this.heartbeatAt=Date.now(); return {accepted:true,observedAt:now()};} }
    this.heartbeatAt=0; throw new GatewayError('HEARTBEAT_FAILED','Exchange did not accept order heartbeat');
    }, false, 5000);
  }
}
