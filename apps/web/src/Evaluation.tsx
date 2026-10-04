import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReplayResult } from '../../../packages/core/src/replay';
import type { SecureWrite } from './Settings';
import { api, percent } from './api';
export function CandidateEvaluation({ secure }: { secure: SecureWrite }) {
  const profiles = useQuery({ queryKey: ['replay-profiles'], queryFn: () => api<{ profileVersion: string; events: number }[]>('/evaluation/profiles'), refetchInterval: 60000 });
  const [profile, setProfile] = useState('');
  const [edge, setEdge] = useState('5');
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReplayResult | null>(null);
  const selected = profile || profiles.data?.[0]?.profileVersion || '';
  async function assess() {
    setError(''); setBusy(true); setResult(null);
    try {
      const minimumEdge = Number(edge) / 100, lookbackDays = Number(days);
      if (!selected || !Number.isFinite(minimumEdge) || minimumEdge < .01 || minimumEdge > 1 || !Number.isInteger(lookbackDays) || lookbackDays < 7 || lookbackDays > 365) throw new Error('Pilih profil, edge 1–100%, dan periode 7–365 hari.');
      setResult(await secure('/evaluation/replay', { profileVersion: selected, minimumEdge, lookbackDays, limit: 2000 }) as ReplayResult);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Assessment gagal'); }
    finally { setBusy(false); }
  }
  return <article className="panel evaluation"><div className="section-head"><div><span className="eyebrow">CANDIDATE ASSESSMENT</span><h3>Evaluasi threshold dari forecast aktual</h3></div></div>
    <p className="muted">Hitung kalibrasi dan return hipotetis dari forecast tersimpan sebelum cutoff. Assessment tidak mengubah policy dan tidak mengaktifkan live.</p>
    {profiles.isLoading && <p className="muted">Memuat profil historis…</p>}
    {profiles.error && <p className="error">{profiles.error.message}</p>}
    {!profiles.isLoading && !profiles.error && !profiles.data?.length && <p className="empty">Belum ada forecast dengan outcome biner terselesaikan. Jalankan paper dan tunggu resolution aktual.</p>}
    <div className="form-grid"><label>Profil historis<select value={selected} disabled={busy || !profiles.data?.length} onChange={event => { setProfile(event.target.value); setResult(null); }}>{!selected && <option value="">Belum tersedia</option>}{profiles.data?.map(item => <option key={item.profileVersion} value={item.profileVersion}>{item.profileVersion} · {item.events} event tercatat</option>)}</select></label>
    <label>Minimum edge (%)<input type="number" min="1" max="100" step="0.1" value={edge} disabled={busy} onChange={event => { setEdge(event.target.value); setResult(null); }}/></label>
    <label>Periode historis (hari)<input type="number" min="7" max="365" step="1" value={days} disabled={busy} onChange={event => { setDays(event.target.value); setResult(null); }}/></label></div>
    <button disabled={busy || !selected} onClick={() => void assess()}>{busy ? 'Menghitung…' : 'Evaluasi kandidat'}</button>
    {error && <p className="error" role="alert">{error}</p>}
    {result && <><p className="notice">{result.status === 'insufficient' ? 'Data belum cukup: butuh minimal 50 event dan 50 sinyal terpilih.' : 'Assessment retrospektif selesai; belum merupakan kelayakan live.'}</p>
      <dl className="detail-record"><div><dt>Event / sinyal terpilih</dt><dd>{result.evidence.events} / {result.evidence.selected}{result.evidence.truncated && ' · dibatasi 2.000 event terbaru'}</dd></div><div><dt>Brier / baseline pasar (lebih rendah lebih baik)</dt><dd>{result.brier?.toFixed(4) ?? '—'} / {result.baselineBrier?.toFixed(4) ?? '—'}</dd></div><div><dt>Return gross hipotetis / rerata per stake 1</dt><dd>{result.hypothetical.grossReturn} / {result.hypothetical.averageReturn ?? '—'}</dd></div><div><dt>Menang / kalah hipotetis</dt><dd>{result.hypothetical.wins} / {result.hypothetical.losses}</dd></div></dl>
      <div className="table-wrap"><table><thead><tr><th>Bucket probabilitas</th><th>Event</th><th>Forecast rata-rata</th><th>Outcome YES aktual</th></tr></thead><tbody>{result.buckets.map(bucket => <tr key={bucket.from}><td>{percent(bucket.from)}–{percent(bucket.to)}</td><td>{bucket.events}</td><td>{percent(bucket.probability)}</td><td>{percent(bucket.outcomeRate)}</td></tr>)}</tbody></table></div>
      {result.limitations.map(note => <p className="muted" key={note}>{note}</p>)}<small className="mono">{result.candidateId} · tersimpan sebagai candidate-assessment</small></>}
  </article>;
}
