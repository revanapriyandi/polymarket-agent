import type { Metrics, RiskSettings } from '../../shared/src/index.js';
import { d } from './ledger.js';

/** Absolute cumulative loss is independent of the equity high-water mark. */
export function lossLimitReason(current: Metrics, risk: RiskSettings): string | null {
  if (risk.maxTotalLoss !== undefined && current.totalPnl !== null && d(current.totalPnl).lte(d(risk.maxTotalLoss).negated())) return 'Batas kerugian total tercapai';
  if (d(current.dailyPnl).lte(d(risk.capital).mul(risk.dailyLoss).negated())) return 'Batas kerugian harian tercapai';
  if (d(current.drawdown).gte(risk.maxDrawdown)) return 'Batas drawdown tercapai';
  return null;
}
