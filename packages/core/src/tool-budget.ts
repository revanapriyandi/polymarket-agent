import { AsyncLocalStorage } from 'node:async_hooks';
import Decimal from 'decimal.js';
export const toolBudget = new AsyncLocalStorage<{remaining:Decimal;signal:AbortSignal}>();
export function consumeToolBudget(value: string) {
  const current=toolBudget.getStore();if(!current)return;
  current.signal.throwIfAborted();
  const cost=new Decimal(value);
  if(!cost.isFinite()||cost.isNegative()||cost.gt(current.remaining))throw new Error('Agent cost budget exceeded');
  current.remaining=current.remaining.minus(cost);
}
