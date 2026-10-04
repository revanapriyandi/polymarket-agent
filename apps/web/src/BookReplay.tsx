import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BookReplayResult } from '../../../packages/core/src/book-replay';
import type { SecureWrite } from './Settings';
import { api, collateral, date } from './api';

export function BookReplay({ secure }: { secure: SecureWrite }) {
  const summary = useQuery({ queryKey: ['book-snapshots'], queryFn: () => api<{ snapshots: number; markets: number; oldest: string | null; newest: string | null }>('/evaluation/books'), refetchInterval: 60000 });
  const [hours, setHours] = useState('24'), [shares, setShares] = useState('10'), [latency, setLatency] = useState('1000'), [slippage, setSlippage] = useState('10'), [merge, setMerge] = useState('0.01');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<BookReplayResult | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 15;
  async function replay() {
    setBusy(true); setError(''); setResult(null); setPage(1);
    try {
      const input = { lookbackHours: Number(hours), maxShares: shares, latencyMs: Number(latency), slippageBps: Number(slippage), mergeCost: merge, limit: 200 };
      if (!Number.isInteger(input.lookbackHours) || input.lookbackHours < 1 || input.lookbackHours > 720 || !Number.isInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 120000 || !Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 1000 || !/^\d+(\.\d{1,8})?$/.test(shares) || Number(shares) <= 0 || Number(shares) > 1000000 || !/^\d+(\.\d{1,8})?$/.test(merge) || Number(merge) > 1000000) throw new Error('Periksa periode 1–720 jam, jumlah saham positif, latency 0–120.000 ms, slippage 0–1.000 bps, dan merge cost nonnegatif.');
      setResult(await secure('/evaluation/books/replay', input) as BookReplayResult);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Replay gagal'); }
    finally { setBusy(false); }
  }
  return <article className="panel evaluation"><div className="section-head"><div><span className="eyebrow">DEPTH REPLAY</span><h3>Replay arbitrase dari order book tersimpan</h3></div></div>
    <p className="muted">Simulasi dua leg FOK pada limit keputusan awal setelah latency. Snapshot maksimal 100 level per sisi. Kandidat tidak mengubah ledger atau kelayakan live.</p>
    {summary.isLoading && <p className="muted">Memuat snapshot…</p>}{summary.error && <p className="error" role="alert">{summary.error.message}</p>}
    {summary.data && <p className={summary.data.snapshots ? 'muted' : 'empty'}>{summary.data.snapshots} snapshot · {summary.data.markets} pasar · terbaru {date(summary.data.newest)}{!summary.data.snapshots && ' · Tunggu scan pasar untuk mengumpulkan order book aktual.'}</p>}
    <fieldset disabled={busy}><div className="form-grid"><label>Periode (jam)<input type="number" min="1" max="720" value={hours} onChange={e => { setHours(e.target.value); setResult(null); }}/></label><label>Maksimal saham per leg<input type="number" min="0.01" max="1000000" step="0.01" value={shares} onChange={e => { setShares(e.target.value); setResult(null); }}/></label><label>Latency (ms)<input type="number" min="0" max="120000" value={latency} onChange={e => { setLatency(e.target.value); setResult(null); }}/></label><label>Slippage (bps)<input type="number" min="0" max="1000" value={slippage} onChange={e => { setSlippage(e.target.value); setResult(null); }}/></label><label>Asumsi merge cost (pUSD)<input type="number" min="0" max="1000000" step="0.00001" value={merge} onChange={e => { setMerge(e.target.value); setResult(null); }}/></label></div></fieldset>
    <button disabled={busy || !summary.data?.snapshots} onClick={() => void replay()}>{busy ? 'Menjalankan replay…' : 'Replay kandidat arbitrase'}</button>{error && <p className="error" role="alert">{error}</p>}
    {result && <><p className="notice">{result.snapshots} snapshot diperiksa{result.truncated && ' · dibatasi 200 terbaru'}. Paired net simulasi: {collateral(result.pairedNet)}{result.unmatchedUnvalued && ' · ada posisi satu sisi belum dinilai; paired net bukan total P&L.'}</p><p className="muted">Paired {result.counts.paired} · satu sisi {result.counts['one-sided']} · tanpa transaksi {result.counts.noop} · stale/hilang {result.counts['stale-missing']}</p>
      <div className="replay-table"><table><thead><tr><th>Pasar / keputusan</th><th>Eksekusi</th><th>Status</th><th>Saham</th><th>Biaya</th><th>Net paired</th><th>Alasan</th></tr></thead><tbody>{result.observations.slice((page-1)*pageSize, page*pageSize).map(item => <tr key={item.snapshotId}><td>{item.question}<br/><small>{date(item.observedAt)}</small></td><td>{date(item.executionAt)}</td><td>{item.status}{item.depthTruncated && ' · depth dibatasi'}</td><td>{item.shares}</td><td>{collateral(item.spent)}</td><td>{collateral(item.net)}</td><td>{item.reason}</td></tr>)}</tbody></table></div>
      {result.observations.length > pageSize && <nav className="trend-pagination" aria-label="Halaman hasil replay"><button disabled={page===1} onClick={() => setPage(value => value-1)}>Sebelumnya</button><small>{page} / {Math.ceil(result.observations.length/pageSize)}</small><button disabled={page*pageSize>=result.observations.length} onClick={() => setPage(value => value+1)}>Berikutnya</button></nav>}
      {!result.observations.length && <p className="empty">Belum ada snapshot dalam periode yang dipilih.</p>}{result.limitations.map(note => <p className="muted" key={note}>{note}</p>)}<small className="mono">{result.candidateId} · book-replay-candidate</small></>}
  </article>;
}
