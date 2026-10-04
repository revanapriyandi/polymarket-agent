import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import type { Metrics, Mode, Settings } from '../../../../packages/shared/src/index';
import { api, collateral, percent } from '../api';

export function Metric({ title, value, note, tone = '' }: { title: string; value: string; note: string; tone?: string }) {
  return <article className={`stat-card ${tone}`}><span>{title}</span><strong>{value}</strong><small>{note}</small></article>;
}
export function pnlTone(value: string | null) { return value == null || Number(value) === 0 ? '' : Number(value) > 0 ? 'positive' : 'negative'; }
export function BalanceSummary({ metrics }: { metrics: Metrics }) {
  return <section className="panel balance-summary"><div className="section-head"><h2>Saldo & alokasi</h2><Link className="inline-link" to="/portfolio/history" aria-label="Buka riwayat saldo"><ArrowUpRight size={16}/></Link></div><dl className="summary-list">
    <div><dt>Saldo kas</dt><dd>{collateral(metrics.cash)}</dd></div>
    <div><dt>Dicadangkan untuk order</dt><dd>{collateral(metrics.reserved)}</dd></div>
    <div><dt>Nilai posisi</dt><dd>{collateral(metrics.positionValue)}</dd></div>
    <div><dt>Menunggu settlement <small>fill belum final + biaya</small></dt><dd>{collateral(metrics.pendingSettlement)}</dd></div>
  </dl></section>;
}
export function RiskSummary({ metrics, mode }: { metrics: Metrics; mode: Mode }) {
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<{ settings: Settings }>('/settings') });
  const policy = query.data?.settings[mode];
  const rows = [
    { label: 'Exposure modal', value: Number(metrics.exposure), limit: policy?.totalExposure },
    { label: 'Drawdown', value: metrics.equity == null ? null : Number(metrics.drawdown), limit: policy?.maxDrawdown },
  ];
  return <section className="panel risk-summary"><div className="section-head"><h2>Batas risiko</h2><Link className="inline-link" to="/settings/risk" aria-label="Atur batas risiko"><ArrowUpRight size={16}/></Link></div>
    {rows.map(row => <div className="risk-meter" key={row.label}><div><span>{row.label}</span><strong>{percent(row.value)}<small> / {percent(row.limit)}</small></strong></div><div className="meter-track" aria-hidden="true"><span className={row.limit != null && row.value != null && row.value >= row.limit ? 'limit-reached' : ''} style={{ width: `${row.limit && row.value != null ? Math.max(0, Math.min(100, row.value / row.limit * 100)) : 0}%` }}/></div></div>)}
    <small>{query.error ? 'Batas konfigurasi gagal dimuat.' : query.isPending ? 'Memuat batas aktif…' : !policy ? 'Batas live belum diisi.' : `Stop kerugian harian ${percent(policy.dailyLoss)} · per event ${percent(policy.eventExposure)}`}</small>
  </section>;
}
