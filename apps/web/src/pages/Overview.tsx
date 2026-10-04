import { Link } from 'react-router';
import { ArrowUpRight, CircleAlert } from 'lucide-react';
import { useTrading } from '../TradingContext';
import { collateral, date } from '../api';
import { EquityChart } from '../Chart';
import { DataTable } from '../DataTable';
import { Metric, BalanceSummary, RiskSummary, pnlTone } from '../components/PortfolioSummary';

export default function Overview() {
  const { snapshot, secure } = useTrading();
  if (!snapshot) return null;
  const { metrics, mode } = snapshot;
  const warning = !snapshot.worker.online ? { text: 'Worker tidak aktif. Pemantauan dan eksekusi perlu diperiksa.', path: '/system/health', action: 'Periksa sistem' }
    : metrics.unmarkedPositions > 0 || metrics.equity == null ? { text: 'Valuasi portofolio belum lengkap. Periksa posisi dan settlement sebelum mengambil keputusan.', path: '/portfolio/positions', action: 'Lihat posisi' }
    : snapshot.readiness.find(item => item.key === 'ai')?.state !== 'ready' ? { text: 'Prediksi AI menunggu koneksi model yang terverifikasi.', path: '/settings/providers', action: 'Atur provider AI' } : null;
  return <div className="page-stack overview-page">
    <section className="stat-grid" aria-label="Ringkasan nilai portofolio">
      <Metric title="Total equity" value={collateral(metrics.equity)} note="Kas + posisi − biaya operasional"/>
      <Metric title="P&L bersih" value={collateral(metrics.totalPnl)} tone={pnlTone(metrics.totalPnl)} note="Setelah biaya trading & operasional"/>
      <Metric title="P&L hari ini" value={collateral(metrics.equity == null ? null : metrics.dailyPnl)} tone={metrics.equity == null ? '' : pnlTone(metrics.dailyPnl)} note="Perubahan sejak awal hari UTC"/>
      <Metric title="Saldo tersedia" value={collateral(metrics.available)} note={`${snapshot.counts.orders ?? 0} order aktif · kas bebas reservasi`}/>
    </section>
    {warning && <div className="trader-notice"><CircleAlert size={16}/><span>{warning.text}</span><Link to={warning.path}>{warning.action}<ArrowUpRight size={14}/></Link></div>}
    <div className="overview-grid"><EquityChart points={snapshot.equity} mode={mode}/><aside className="portfolio-aside"><BalanceSummary metrics={metrics}/><RiskSummary metrics={metrics} mode={mode}/></aside></div>
    <DataTable key={mode} name="positions" mode={mode} secure={secure} compact/>
    <div className="page-footnote"><span>Snapshot {date(snapshot.at)}</span><Link className="inline-link" to="/analytics/performance">Analisis biaya & performa <ArrowUpRight size={14}/></Link></div>
  </div>;
}
