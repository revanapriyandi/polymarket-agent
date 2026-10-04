import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, CircleHelp, LogOut, Pause, Play, Settings2, ShieldCheck, Square, Wallet, Zap } from 'lucide-react';
import type { DashboardSnapshot, SkillDefinition } from '../../../packages/shared/src/index';
import { api, date, money, percent, collateral } from './api';
import { EquityChart } from './Chart';
import { CandidateEvaluation } from './Evaluation';
import { BookReplay } from './BookReplay';
import { DataTable } from './DataTable';
import { Drawer } from './Drawer';
import { Trends } from './Services';
import { Settings, type SecureWrite } from './Settings';
export function App() {
    const client = useQueryClient();
    const session = useQuery({ queryKey: ['session'], queryFn: () => api<{
            user?: {
                email: string;
            };
        } | null>('/auth/get-session'), retry: false });
    if (session.isPending)
        return <main className="login"><span className="brand">P<span>/</span>M</span><p>Memeriksa sesi owner…</p></main>;
    if (session.error)
        return <main className="login"><p className="error">Server tidak dapat dihubungi: {session.error.message}</p><button onClick={() => void session.refetch()}>Coba lagi</button></main>;
    if (!session.data?.user)
        return <Login onSuccess={() => void client.invalidateQueries({ queryKey: ['session'] })}/>;
    return <Dashboard email={session.data.user.email}/>;
}
function Login({ onSuccess }: {
    onSuccess: () => void;
}) { const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); return <main className="login"><div className="login-brand"><span className="brand">P<span>/</span>M</span><span className="eyebrow">AUTONOMOUS MARKET OPERATIONS</span></div><form onSubmit={e => { e.preventDefault(); setBusy(true); setError(''); void api('/auth/sign-in/email', { email, password }).then(() => { setPassword(''); onSuccess(); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}><span className="eyebrow">OWNER ACCESS</span><h1>Masuk ke ruang operasi.</h1><p className="muted">Pantau strategi, risiko, dan keputusan agent dari satu tempat.</p><label>Email<input type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}/></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/></label>{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Memverifikasi…' : 'Masuk'}<ArrowUpRight size={16}/></button><small>Akun owner dibuat melalui CLI. Registrasi publik dinonaktifkan.</small></form><div className="login-note"><ShieldCheck size={16}/> Kredensial disimpan pada server; sesi melalui cookie.</div></main>; }
function Dashboard({ email }: {
    email: string;
}) {
    const client = useQueryClient();
    const snapshot = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardSnapshot>('/dashboard'), refetchInterval: 30000 });
    const skills = useQuery({ queryKey: ['skills'], queryFn: () => api<SkillDefinition[]>('/skills') });
    const [stream, setStream] = useState(false);
    const [settings, setSettings] = useState(false);
    const [agent, setAgent] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [stepUp, setStepUp] = useState(false);
    const resolver = useRef<{
        resolve: (v: string) => void;
        reject: (e: Error) => void;
    } | null>(null);
    useEffect(() => {
        const events = new EventSource('/api/events', { withCredentials: true });
        events.onopen = () => setStream(true);
        events.onerror = () => setStream(false); events.addEventListener('unavailable',()=>setStream(false));
        events.addEventListener('snapshot', event => {
            try {
                client.setQueryData(['dashboard'], JSON.parse((event as MessageEvent).data));
                setStream(true);
            }
            catch {
                setStream(false);
            }
        });
        return () => { events.close(); resolver.current?.reject(new Error('Sesi ditutup')); resolver.current = null; };
    }, [client]);
    const secure: SecureWrite = useCallback(async (path, body, method) => {
        if (resolver.current)
            throw new Error('Selesaikan verifikasi yang sedang terbuka terlebih dahulu');
        const token = await new Promise<string>((resolve, reject) => { resolver.current = { resolve, reject }; setStepUp(true); });
        return api(path, body, method, token);
    }, []);
    async function control(action: string) {
        const texts: Record<string, string> = { pause: 'Jeda operasi dan antrekan pembatalan order terbuka?', resume: 'Lanjutkan operasi sesuai profil risiko aktif?', emergency: 'Emergency stop: hentikan operasi dan batalkan order sesuai kebijakan server?', paper: 'Pindah ke mode paper?', 'activate-live': 'Aktifkan trading dengan dana nyata? Semua gate readiness dan evaluasi harus lulus.' };
        if (!confirm(texts[action]))
            return;
        try {
            setBusy(true);
            setError('');
            await secure('/control', { action });
            await snapshot.refetch();
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    const s = snapshot.data;
    const stale = !!s && (Date.now() - new Date(s.at).getTime() > 90000);
    const currentAgent = s?.agents.find(a => a.role === agent);
    const skill = skills.data?.find(k => k.role === agent);
    return <div className="shell"><aside className="rail"><a className="brand" href="#overview" aria-label="Polymarket Operations">P<span>/</span>M</a><a className="rail-link active" href="#overview" aria-label="Overview"><Activity size={21}/></a><a className="rail-link" href="#agents" aria-label="Agents"><Zap size={21}/></a><a className="rail-link" href="#records" aria-label="Portfolio"><Wallet size={21}/></a><button className="rail-link bottom" aria-label="Pengaturan" onClick={() => setSettings(true)}><Settings2 size={21}/></button></aside><main className="workspace" id="overview"><header className="topbar"><div><span className="eyebrow">POLYMARKET / CONTROL ROOM</span><h1>Market operations<span className="title-dot">.</span></h1></div><div className="top-actions"><span className={'connection ' + (stream && !stale ? 'online' : 'offline')}><i />{stream && !stale ? 'SSE terhubung' : 'Koneksi / data stale'}</span><button className="icon" title={email} aria-label="Keluar" onClick={() => void api('/auth/sign-out', {}).then(() => { client.clear(); return client.invalidateQueries({ queryKey: ['session'] }); }).catch(e => setError(e.message))}><LogOut size={17}/></button></div></header><section className="control-bar"><div className="actions"><span className={'mode ' + (s?.mode ?? 'paper')}>{s?.mode === 'live' ? 'LIVE CAPITAL' : 'PAPER TRADING'}</span><span className="muted">{s?.control ?? 'Memuat'} <span className="divider">/</span> Policy v{s?.policyVersion ?? '—'}</span></div><div className="actions"><button disabled={busy || !s} onClick={() => void control(s?.control === 'running' ? 'pause' : 'resume')}>{s?.control === 'running' ? <Pause size={14}/> : <Play size={14}/>} {s?.control === 'running' ? 'Jeda' : 'Lanjutkan'}</button><button disabled={busy || !s} onClick={() => void control(s?.mode === 'live' ? 'paper' : 'activate-live')}>{s?.mode === 'live' ? 'Mode paper' : 'Aktifkan live'}</button><button disabled={busy || !s} className="danger" onClick={() => void control('emergency')}><Square size={12}/> Emergency stop</button><button onClick={() => setSettings(true)}><Settings2 size={14}/> Pengaturan</button></div></section>{error && <p className="error" role="alert">{error}</p>}{snapshot.error && <p className="error">{snapshot.error.message} <button onClick={() => void snapshot.refetch()}>Coba lagi</button></p>}{(!stream || stale) && <div className="notice">Data tidak tersambung secara real time. Snapshot terakhir: {s ? date(s.at) : 'belum tersedia'}. Status dan valuasi dapat terlambat.</div>}{!s ? <div className="empty">Memuat snapshot operasi…</div> : <><p className="denomination-note">{s.mode==='paper'?'Paper: saldo dan P&L virtual dalam pUSD.':'Live: saldo dan valuasi collateral dalam pUSD.'} Biaya AI/layanan berasal dari estimasi USD yang dikonversi sesuai konfigurasi; pUSD tidak dijamin setara USD.</p><section className="metrics"><Metric name="TOTAL EQUITY" value={collateral(s.metrics.equity)} note={`${s.metrics.unmarkedPositions} posisi belum memiliki mark`} accent/><Metric name="NET P&L" value={collateral(s.metrics.totalPnl)} note={`Realisasi ${collateral(s.metrics.realizedPnl)} · unrealized ${collateral(s.metrics.unrealizedPnl)}`}/><Metric name="AVAILABLE BALANCE" value={collateral(s.metrics.available)} note={`Cash ${collateral(s.metrics.cash)} · reserved ${collateral(s.metrics.reserved)} · settlement ${collateral(s.metrics.pendingSettlement)}`}/><Metric name="EXPOSURE / DRAWDOWN" value={`${percent(s.metrics.exposure)} / ${percent(s.metrics.drawdown)}`} note={`Trading ${collateral(s.metrics.tradingFees)} · operasi ${collateral(s.metrics.operatingCosts)}`}/></section><div className="main-grid"><EquityChart points={s.equity} mode={s.mode}/><section className="panel readiness"><div className="section-head"><div><span className="eyebrow">SYSTEM CHECKS</span><h2>Readiness</h2></div><ShieldCheck size={18}/></div><div className="worker-status"><i className={s.worker.online ? 'dot online' : 'dot offline'}/><span>Worker {s.worker.online ? 'online' : 'offline'} · feed {s.worker.feedConnected ? 'connected' : 'disconnected'}</span></div>{s.readiness.map(r => <div className="readiness-row" key={r.key}><div><strong>{r.name}</strong><small>{r.reason}</small></div><span className={'badge ' + r.state}>{r.state}</span></div>)}<footer>Heartbeat {date(s.worker.heartbeatAt)}<br />Rekonsiliasi {date(s.worker.reconciliationAt)}</footer></section></div><section id="agents" className="agent-section"><div className="section-head"><div><span className="eyebrow">MULTI-AGENT WORKFORCE</span><h2>Agent runtime</h2></div><span className="muted">{s.agents.filter(a => a.status === 'running').length} running / {s.agents.length} agents</span></div><div className="agents">{s.agents.map((a, i) => <button className="agent-card" key={a.role} onClick={() => setAgent(a.role)}><div className="section-head"><span className="agent-number">{String(i + 1).padStart(2, '0')}</span><span className={'badge ' + a.status}>{a.status}</span></div><strong>{a.name}</strong><span className="agent-tool">{a.lastTool ?? 'Belum ada tool call'}</span><small>{a.reason || 'Menunggu pekerjaan'}</small><footer>{a.runs} runs · {a.durationMs == null ? '—' : `${a.durationMs} ms`}<ArrowUpRight size={13}/></footer></button>)}</div></section><section className="evaluation-section"><div className="section-head"><div><span className="eyebrow">PROMOTION POLICY</span><h2>Evaluasi paper → live</h2></div><CircleHelp size={17}/></div><div className="evaluations">{s.evaluations.length ? s.evaluations.map(e => <article className="panel evaluation" key={`${e.strategy}-${e.profileVersion}`}><div className="section-head"><strong>{e.strategy}</strong><span className={'badge ' + (e.eligible ? 'ready' : 'blocked')}>{e.eligible ? 'Eligible' : 'Belum eligible'}</span></div><div className="evaluation-stats"><span>{e.paperDays}<small>paper days</small></span><span>{e.closedTrades}<small>closed trades</small></span><span>{e.resolvedEvents}<small>resolved events</small></span><span>{collateral(e.netPnl)}<small>net P&L</small></span></div><p className="muted">Drawdown {percent(e.maxDrawdown)} · unresolved {e.unresolved} · Brier {e.brier ?? '—'} / baseline {e.baselineBrier ?? '—'}</p>{e.reasons.map((r, i) => <p className="gate-reason" key={i}>↳ {r}</p>)}<small className="mono" title={e.profileVersion}>Profile {e.profileVersion.slice(0, 10)} · {e.profileVersion.slice(10)}</small></article>) : <div className="panel empty">Belum ada evaluasi. Live tetap mengikuti gate server.</div>}</div></section><CandidateEvaluation secure={secure}/><BookReplay secure={secure}/><Trends/><div id="records"><DataTable key={s.mode} secure={secure} mode={s.mode}/></div><section className="panel activity"><div className="section-head"><div><span className="eyebrow">AUDIT STREAM</span><h2>Aktivitas terbaru</h2></div><span className="muted">Snapshot {date(s.at)}</span></div>{s.activities.length ? s.activities.slice(0, 10).map(a => <div className="activity-row" key={a.id}><span className="mono muted">{date(a.at)}</span><span className={'badge ' + a.level}>{a.role}</span><div><strong>{a.title}</strong><small>{a.detail}</small></div></div>) : <div className="empty">Belum ada aktivitas tersimpan.</div>}</section></>}<footer className="workspace-footer"><span>POLYMARKET OPERATIONS</span><span>Valuasi aktual · tidak ada jaminan hasil trading</span></footer></main>{settings && <Settings onClose={() => setSettings(false)} secure={secure}/>} {currentAgent && <Drawer title={currentAgent.name} onClose={() => setAgent(null)}><dl className="detail-record">{Object.entries(currentAgent).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v ?? '—')}</dd></div>)}</dl>{skills.error && <p className="error">{skills.error.message}</p>}{skill ? <><h3>{skill.name} · v{skill.version}</h3><p className="muted">{skill.description}</p><dl className="detail-record"><div><dt>Role / permissions</dt><dd>{skill.role} · hanya tool allowlist server</dd></div><div><dt>Tools</dt><dd>{skill.tools.join(', ')}</dd></div><div><dt>Runtime limits</dt><dd>{skill.maxSteps} steps · {skill.maxDurationMs} ms · {money(skill.maxCostUsd)}</dd></div><div><dt>Freshness / failure policy</dt><dd>{skill.freshnessSeconds}s · {skill.failurePolicy}</dd></div></dl><h3>Input / output contract</h3><pre className="record">{JSON.stringify({ input: skill.inputSchema, output: skill.outputSchema }, null, 2)}</pre></> : <p className="muted">Skill definition belum tersedia.</p>}</Drawer>}{stepUp && <Reauth onClose={() => { resolver.current?.reject(new Error('Verifikasi dibatalkan')); resolver.current = null; setStepUp(false); }} onToken={token => { resolver.current?.resolve(token); resolver.current = null; setStepUp(false); }}/>}</div>;
}
function Metric({ name, value, note, accent = false }: {
    name: string;
    value: string;
    note: string;
    accent?: boolean;
}) { return <article className={'metric ' + (accent ? 'accent' : '')}><span className="eyebrow">{name}</span><strong>{value}</strong><small>{note}</small></article>; }
function Reauth({ onClose, onToken }: {
    onClose: () => void;
    onToken: (token: string) => void;
}) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    return <Drawer title="Verifikasi perubahan sensitif" onClose={onClose}><form className="form" onSubmit={e => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void api<{
                token: string;
                expiresAt: string;
            }>('/security/reauth', { password }).then(r => {
                if (!r.token)
                    throw new Error('Token verifikasi tidak tersedia');
                setPassword('');
                onToken(r.token);
            }).catch(e => setError(e.message)).finally(() => setBusy(false));
        }}><p className="muted">Masukkan password owner untuk melanjutkan aksi ini. Token hanya berada di memori untuk permintaan ini.</p><label>Password owner<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/></label>{error && <p className="error" role="alert">{error}</p>}<button disabled={busy} className="primary">{busy ? 'Memverifikasi…' : 'Verifikasi dan lanjutkan'}</button></form></Drawer>;
}
