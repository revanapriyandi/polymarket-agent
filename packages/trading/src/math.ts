import Decimal from 'decimal.js';
import type { BookLevel, Market, OrderBook } from '../../shared/src/index';
import { GatewayError } from './errors';
export const D = (value: Decimal.Value) => new Decimal(value);
export function roundShares(shares: string) { return D(shares).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2); }
export function roundPrice(price: string, tick: string, side: 'BUY' | 'SELL') { return D(price).div(tick).toDecimalPlaces(0, side === 'BUY' ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL).mul(tick).toFixed(); }
export function feeFor(market: Market, price: string, shares: string): string {
  if (!market.fee || !D(market.fee.rate).isFinite() || market.fee.exponent < 0) throw new GatewayError('UNKNOWN_FEES', 'Verified fee parameters are required');
  if (market.fee.exponent !== 1 && !D(market.fee.rate).eq(0)) throw new GatewayError('UNSUPPORTED_FEES', 'Only the verified current fee curve is supported');
  const p = D(price); return D(shares).mul(market.fee.rate).mul(p.mul(D(1).minus(p))).toFixed(5, Decimal.ROUND_UP);
}
export function executableDepth(levels: BookLevel[], shares: string, limitPrice: string, side: 'BUY' | 'SELL') {
  let remaining = D(shares), cost = D(0), worst = D(0);
  const sorted = [...levels].sort((a, b) => side === 'BUY' ? D(a.price).cmp(b.price) : D(b.price).cmp(a.price));
  for (const level of sorted) {
    if (side === 'BUY' ? D(level.price).gt(limitPrice) : D(level.price).lt(limitPrice)) break;
    const fill = Decimal.min(remaining, level.size); if (fill.lte(0)) continue;
    cost = cost.plus(fill.mul(level.price)); remaining = remaining.minus(fill); worst = D(level.price); if (remaining.eq(0)) break;
  }
  return { filledShares: D(shares).minus(remaining).toFixed(), complete: remaining.eq(0), cost: cost.toFixed(), worstPrice: worst.toFixed(), averagePrice: remaining.eq(shares) ? '0' : cost.div(D(shares).minus(remaining)).toFixed(8) };
}
export function arbitrageQuote(market: Market, yes: OrderBook, no: OrderBook, shares: string, mergeCost: string, slippageBps: number) {
  const size = roundShares(shares); const a = executableDepth(yes.asks, size, '0.9999', 'BUY'), b = executableDepth(no.asks, size, '0.9999', 'BUY');
  if (!a.complete || !b.complete || D(size).lt(yes.minOrderSize) || D(size).lt(no.minOrderSize)) return null;
  const depthFee = (levels: BookLevel[]) => { let remaining = D(size), total = D(0); for (const level of [...levels].sort((x, y) => D(x.price).cmp(y.price))) { const fill = Decimal.min(remaining, level.size); total = total.plus(feeFor(market, level.price, fill.toFixed())); remaining = remaining.minus(fill); if (remaining.eq(0)) break; } return total; };
  const fee = depthFee(yes.asks).plus(depthFee(no.asks));
  const cost = D(a.cost).plus(b.cost).mul(D(1).plus(D(slippageBps).div(10000))).plus(fee).plus(mergeCost);
  return { shares: size, yesLimit: a.worstPrice, noLimit: b.worstPrice, cost: cost.toFixed(8), fees: fee.toFixed(8), netProfit: D(size).minus(cost).toFixed(8), edge: D(size).minus(cost).div(size).toNumber() };
}
