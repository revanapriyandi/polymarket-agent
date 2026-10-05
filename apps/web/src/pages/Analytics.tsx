import { useTrading } from '../TradingContext';
import { EquityChart } from '../Chart';
import { collateral, percent } from '../api';
import { Metric, RiskSummary, pnlTone } from '../components/PortfolioSummary';
import { CandidateEvaluation } from '../Evaluation';
import { BookReplay } from '../BookReplay';
import { AnalyticsBreakdown } from '../components/AnalyticsBreakdown';

export function Performance() {
  const { snapshot } = useTrading();
  if (!snapshot) return null;
  const { metrics } = snapshot;
  return <div className="page-stack"><section className="stat-grid">
    <Metric title="P&L terealisasi" value={collateral(metrics.realizedPnl)} tone={pnlTone(metrics.realizedPnl)} note="Sudah dikurangi biaya trading"/>
    <Metric title="P&L belum realisasi" value={collateral(metrics.unrealizedPnl)} tone={pnlTone(metrics.unrealizedPnl)} note="Nilai mark dikurangi basis biaya"/>
    <Metric title="Biaya operasional" value={collateral(metrics.operatingCosts)} note="AI, data, dan infrastruktur"/>
    <Metric title="P&L bersih" value={collateral(metrics.totalPnl)} tone={pnlTone(metrics.totalPnl)} note="Realisasi + belum realisasi − operasi"/>
  </section><EquityChart points={snapshot.equity} mode={snapshot.mode}/><div className="two-column"><section className="panel"><h2>Rincian performa</h2><dl className="summary-list">
    <div><dt>Modal tercatat</dt><dd>{collateral(metrics.capital)}</dd></div><div><dt>Biaya trading tercatat</dt><dd>{collateral(metrics.tradingFees)}</dd></div><div><dt>Biaya operasional terkonversi</dt><dd>{collateral(metrics.operatingCosts)}</dd></div><div><dt>Posisi belum memiliki mark</dt><dd>{metrics.unmarkedPositions}</dd></div>
  </dl><small>Biaya trading sudah masuk P&L terealisasi. Biaya layanan dikonversi dari USD sesuai pengaturan; pUSD tidak dijamin setara USD.</small></section><RiskSummary metrics={metrics} mode={snapshot.mode}/></div><AnalyticsBreakdown/></div>;
}
export function Evaluation() {
  const { snapshot, secure } = useTrading();
  if (!snapshot) return null;
  return <div className="page-stack"><div className="evaluations">{snapshot.evaluations.length ? snapshot.evaluations.map(item => <article className="panel evaluation" key={`${item.strategy}-${item.profileVersion}`}>
    <div className="section-head"><h2>{item.strategy === 'arbitrage' ? 'Arbitrase' : 'Prediksi AI'}</h2><span className={`badge ${item.eligible ? 'ready' : 'blocked'}`}>{item.eligible ? 'Memenuhi evaluasi' : 'Belum memenuhi'}</span></div>
    <div className="evaluation-stats"><span>{item.paperDays}<small>hari paper</small></span><span>{item.closedTrades}<small>transaksi selesai</small></span><span>{item.resolvedEvents}<small>event selesai</small></span><span>{collateral(item.netPnl)}<small>P&L bersih paper</small></span></div>
    <p className="muted">Drawdown {percent(item.maxDrawdown)} · {item.unresolved} belum direkonsiliasi · Brier {item.brier?.toFixed(4) ?? '—'} / baseline {item.baselineBrier?.toFixed(4) ?? '—'}</p>
    {item.reasons.map(reason => <p className="gate-reason" key={reason}>{reason}</p>)}<details className="audit-detail"><summary>Versi profil</summary><small className="mono">{item.profileVersion}</small></details>
  </article>) : <div className="panel empty">Belum ada evaluasi strategi. Data paper perlu terkumpul sebelum strategi dapat dinilai.</div>}</div><CandidateEvaluation secure={secure}/></div>;
}
export function Replay() { const { secure } = useTrading(); return <BookReplay secure={secure}/>; }
