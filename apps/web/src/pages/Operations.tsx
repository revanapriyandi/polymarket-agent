import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import type { SkillDefinition } from '../../../../packages/shared/src/index';
import { useTrading } from '../TradingContext';
import { api, date, money } from '../api';
import { Drawer } from '../Drawer';

export function Agents() {
  const { snapshot } = useTrading();
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<SkillDefinition[]>('/skills') });
  const [selected, setSelected] = useState<string | null>(null);
  const agent = snapshot?.agents.find(item => item.role === selected), skill = skills.data?.find(item => item.role === selected);
  return <><div className="agents">{snapshot?.agents.map((item, index) => <button className="agent-card" key={item.role} onClick={() => setSelected(item.role)}><div className="section-head"><span className="agent-number">{String(index + 1).padStart(2, '0')}</span><span className={`badge ${item.status}`}>{item.status}</span></div><strong>{item.name}</strong><span className="agent-tool">{item.lastTool ?? 'Belum ada pemanggilan tool'}</span><small>{item.reason || 'Menunggu pekerjaan'}</small><footer>{item.runs} pekerjaan · {item.durationMs == null ? '—' : `${item.durationMs} ms`}<ArrowUpRight size={13}/></footer></button>)}</div>{!snapshot?.agents.length && <div className="panel empty">Belum ada aktivitas agent. Periksa status worker pada Kesehatan sistem.</div>}
    {agent && <Drawer title={agent.name} onClose={() => setSelected(null)}><dl className="detail-record"><div><dt>Status</dt><dd>{agent.status}</dd></div><div><dt>Aktivitas terakhir</dt><dd>{agent.reason}</dd></div><div><dt>Tool terakhir</dt><dd>{agent.lastTool ?? '—'}</dd></div><div><dt>Terakhir bekerja</dt><dd>{date(agent.lastRunAt)}</dd></div><div><dt>Heartbeat</dt><dd>{date(agent.heartbeatAt)}</dd></div></dl>
      {skills.error && <p className="error">{skills.error.message}</p>}{skill ? <><h3>{skill.name} · v{skill.version}</h3><p className="muted">{skill.description}</p><dl className="detail-record"><div><dt>Tools yang diizinkan</dt><dd>{skill.tools.join(', ')}</dd></div><div><dt>Batas pekerjaan</dt><dd>{skill.maxSteps} langkah · {skill.maxDurationMs} ms · {money(skill.maxCostUsd)}</dd></div><div><dt>Kesegaran data</dt><dd>{skill.freshnessSeconds} detik</dd></div><div><dt>Saat gagal</dt><dd>{skill.failurePolicy}</dd></div></dl><details className="audit-detail"><summary>Kontrak input / output</summary><pre>{JSON.stringify({ input: skill.inputSchema, output: skill.outputSchema }, null, 2)}</pre></details></> : <p className="muted">Definisi skill belum tersedia.</p>}
    </Drawer>}</>;
}
const readinessLinks: Record<string, string> = { ai: '/settings/providers', research: '/settings/services', wallet: '/settings/wallet', risk: '/settings/risk', evaluation: '/analytics/evaluation' };
export function Health() {
  const { snapshot, busy, control } = useTrading();
  if (!snapshot) return null;
  return <div className="page-stack"><section className="panel"><div className="section-head"><h2>Operasi & mode trading</h2><span className={`badge ${snapshot.worker.online ? 'ready' : 'degraded'}`}>Worker {snapshot.worker.online ? 'online' : 'offline'}</span></div><p className="muted">Heartbeat {date(snapshot.worker.heartbeatAt)} · rekonsiliasi live {date(snapshot.worker.reconciliationAt)}</p><div className="actions"><span className={`mode ${snapshot.mode}`}>{snapshot.mode.toUpperCase()}</span><button disabled={busy} onClick={() => void control(snapshot.mode === 'live' ? 'paper' : 'activate-live')}>{snapshot.mode === 'live' ? 'Pindah ke paper' : 'Aktifkan live'}</button><Link className="inline-link" to="/analytics/evaluation">Lihat persyaratan evaluasi <ArrowUpRight size={14}/></Link></div></section><section className="panel health-list"><h2>Kesiapan layanan</h2>{snapshot.readiness.map(item => <div className="readiness-row" key={item.key}><div><strong>{item.name}</strong><small>{item.reason}</small>{readinessLinks[item.key] && <Link className="inline-link" to={readinessLinks[item.key]}>Buka {item.key === 'evaluation' ? 'evaluasi' : 'pengaturan'} <ArrowUpRight size={12}/></Link>}</div><span className={`badge ${item.state}`}>{item.state === 'unconfigured' ? 'Belum dikonfigurasi' : item.state === 'ready' ? 'Siap' : item.state === 'blocked' ? 'Diblokir' : 'Terganggu'}</span></div>)}</section></div>;
}
export function ActivityLog() {
  const { snapshot } = useTrading();
  const [level, setLevel] = useState(''), [search, setSearch] = useState('');
  const activities = snapshot?.activities.filter(item => (!level || item.level === level) && `${item.title} ${item.detail} ${item.role}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <section className="panel activity-log"><div className="table-toolbar"><input aria-label="Cari aktivitas" placeholder="Cari aktivitas atau agent…" value={search} onChange={event => setSearch(event.target.value)}/><select aria-label="Tingkat aktivitas" value={level} onChange={event => setLevel(event.target.value)}><option value="">Semua tingkat</option><option value="info">Informasi</option><option value="warning">Peringatan</option><option value="error">Error</option></select><small>{activities.length} dari {snapshot?.activities.length ?? 0} aktivitas terbaru</small></div>{activities.map(item => <article className="activity-row" key={item.id}><time className="mono muted">{date(item.at)}</time><span className={`badge ${item.level}`}>{item.role}</span><div><strong>{item.title}</strong><small>{item.detail}</small></div></article>)}{!activities.length && <div className="empty">Tidak ada aktivitas yang sesuai.</div>}<footer>Menampilkan hingga 35 aktivitas terakhir. Riwayat tools dan transaksi tersedia di submenu masing-masing.</footer></section>;
}
