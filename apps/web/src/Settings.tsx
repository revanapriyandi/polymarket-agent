import { useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultRisk, ProviderConfigSchema, ProviderSecretsSchema, AssignmentSchema, SettingsSchema, ProviderProtocolSchema, type Settings as SettingsType, type ProviderConfig, type ProviderView, type ModelAssignment } from '../../../packages/shared/src/index';
import { api, money } from './api';
import { settingLabel as label, providerLabels, providerEndpointHint } from './settings-labels';
import { Services } from './Services';
import { SettingsHelp } from './SettingsHelp';
import { type SettingsTab } from './settings-help';
import { WalletSetup } from './WalletSetup';
import { ProviderUsageFields } from './ProviderUsageFields';
type SettingsResponse = {
    settings: SettingsType;
    version: number;
    assignments: ModelAssignment[];
};
export type SecureWrite = (path: string, body: unknown, method?: string) => Promise<unknown>;
export function Settings({ tab, secure }: {
    tab: SettingsTab;
    secure: SecureWrite;
}) {
    const [helpOpen, setHelpOpen] = useState(false);
    const helpButton = useRef<HTMLButtonElement>(null);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const query = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/settings') });
    return <section className="panel settings-page">
        <div className="settings-help-bar"><span>Butuh petunjuk untuk {tab.toLowerCase()}?</span><button ref={helpButton} onClick={() => setHelpOpen(true)}><CircleHelp size={16}/>Cara mengisi</button></div>
        {error && <p className="error" role="alert">{error}</p>}{message && <p className="success" role="status">{message}</p>}
        {query.isPending ? <p className="empty">Memuat pengaturan…</p> : query.error ? <p className="error">{query.error.message}</p> : query.data && <>
            {tab === 'Risiko' && <RiskForm key={query.data.version} data={query.data} secure={secure} report={setMessage} error={setError}/>}
            {tab === 'Provider AI' && <Providers secure={secure} assignments={query.data.assignments}/>}
            {tab === 'Layanan' && <Services secure={secure}/>}
            {tab === 'Wallet' && <WalletSetup data={query.data} secure={secure}/>}
        </>}
        {helpOpen && <SettingsHelp topic={tab} onClose={() => setHelpOpen(false)} returnFocusRef={helpButton}/>}
    </section>;
}
function RiskForm({ data, secure, report, error }: {
    data: SettingsResponse;
    secure: SecureWrite;
    report: (s: string) => void;
    error: (s: string) => void;
}) {
    const [settings, setSettings] = useState(data.settings);
    const [busy, setBusy] = useState(false);
    const client = useQueryClient();
    async function save() {
        try {
            setBusy(true);
            error('');
            const parsed = SettingsSchema.safeParse(settings);
            if (!parsed.success)
                throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n'));
            await secure('/settings', { settings: parsed.data, expectedVersion: data.version }, 'PUT');
            await client.invalidateQueries({ queryKey: ['settings'] });
            report('Pengaturan tersimpan.');
        }
        catch (e) {
            error((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="form"><p className="muted">Batas risiko disimpan terpisah untuk paper dan live. Modal, batas biaya, liquidity dan volume menggunakan pUSD; rasio 0–1 (0,01 = 1%, 0,10 = 10%); slippage menggunakan basis points (100 bps = 1%). Mengubah modal paper mencatat deposit/withdrawal selisih tanpa menghapus profit, trades, atau riwayat.</p>{(['paper', 'live'] as const).map(mode => <fieldset key={mode}><legend>{mode.toUpperCase()} / RISK PROFILE</legend>{mode === 'live' && <label className="check"><input type="checkbox" checked={!!settings.live} onChange={e => setSettings({ ...settings, live: e.target.checked ? { ...defaultRisk } : null })}/>Konfigurasi profil live</label>}{settings[mode] && <div className="form-grid">{Object.entries(settings[mode]!).filter(([key]) => key !== 'maxTotalLoss').map(([key, value]) => <label key={key}>{label(key)}<input type="number" min="0" step={typeof value === 'string' ? '0.00000001' : key === 'slippageBps' || key === 'maxHoldingHours' ? '1' : '0.001'} value={value} onChange={e => setSettings({ ...settings, [mode]: { ...settings[mode], [key]: typeof value === 'string' ? e.target.value : Number(e.target.value) } })}/></label>)}<label>{label("maxTotalLoss")}<input type="number" min="0.00000001" step="0.00000001" placeholder="Opsional" value={settings[mode]?.maxTotalLoss ?? ""} onChange={e => setSettings({ ...settings, [mode]: { ...settings[mode]!, maxTotalLoss: e.target.value || undefined } })}/><small>Hentikan entry pada kerugian kumulatif ini, terpisah dari drawdown.</small></label></div>}</fieldset>)}<fieldset><legend>WORKER & COSTS</legend><p className="muted">Budget layanan/infrastruktur dalam USD estimasi; service cost conversion adalah nilai pUSD per USD yang Anda konfigurasi, bukan kurs real time.</p><div className="form-grid">{Object.entries(settings).filter(([k, v]) => typeof v === 'number' || typeof v === 'string' && k !== 'walletAddress').map(([key, value]) => <label key={key}>{label(key)}<input type="number" min="0" step="any" value={String(value)} onChange={e => setSettings({ ...settings, [key]: typeof value === 'number' ? Number(e.target.value) : e.target.value })}/></label>)}</div>{Object.entries(settings.strategyEnabled).map(([key, v]) => <label className="check" key={key}><input type="checkbox" checked={v} onChange={e => setSettings({ ...settings, strategyEnabled: { ...settings.strategyEnabled, [key]: e.target.checked } })}/>{label(key)} aktif</label>)}</fieldset><button disabled={busy} className="primary" onClick={() => void save()}>{busy ? 'Menyimpan…' : 'Simpan konfigurasi'}</button></div>;
}
const blank: ProviderConfig = { name: '', protocol: 'openai-responses', endpoint: '', model: '', enabled: false, timeoutMs: 30000, maxOutputTokens: 2000, concurrency: 1, retries: 0, callsPerMinute: 10, callsPerDay: 300, callsPerMonth: 9000, billingMode: 'metered', dailyBudgetUsd: '0', monthlyBudgetUsd: '0', inputPricePerMillion: undefined, outputPricePerMillion: undefined };
function Providers({ secure, assignments }: {
    secure: SecureWrite;
    assignments: ModelAssignment[];
}) {
    const client = useQueryClient();
    const query = useQuery({ queryKey: ['providers'], queryFn: () => api<ProviderView[]>('/providers') });
    const [editing, setEditing] = useState<ProviderView | null>(null);
    const [config, setConfig] = useState<ProviderConfig>(blank);
    const [secret, setSecret] = useState('');
    const [authHeader, setAuthHeader] = useState('');
    const [headers, setHeaders] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [models, setModels] = useState<unknown>(null);
    const [role, setRole] = useState<ModelAssignment['role']>('research');
    const [primary, setPrimary] = useState(assignments.find(a => a.role === 'research')?.primaryId ?? '');
    const [fallback, setFallback] = useState(assignments.find(a => a.role === 'research')?.fallbackEnabled ?? false);
    const [fallbackIds, setFallbackIds] = useState<string[]>(assignments.find(a => a.role === 'research')?.fallbackIds ?? []);
    async function action(fn: () => Promise<unknown>) {
        try {
            setBusy(true);
            setError('');
            await fn();
            await Promise.all([client.invalidateQueries({ queryKey: ['providers'] }), client.invalidateQueries({ queryKey: ['settings'] })]);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="form">{error && <p className="error">{error}</p>}{query.error && <p className="error">{query.error.message}</p>}<p className="muted">Kunci disimpan terenkripsi. Pilih tarif per token atau kuota gateway internal sebelum menjalankan Probe. Setelah lulus, tetapkan model untuk riset, pemeriksaan bukti, dan forecast.</p>{query.isPending && <p>Memuat provider…</p>}{query.data?.map(p => <article className="provider-card" key={p.id}><div className="section-head"><strong>{p.name}</strong><span className={'badge ' + p.status}>{p.status}</span></div><p className="mono">{p.model} · {p.protocol}</p><small>{p.reason ?? (p.hasSecret ? 'Secret terkonfigurasi' : 'Secret belum diisi')} · {p.callsToday}/{p.callsPerDay} panggilan hari ini · {p.callsMonth}/{p.callsPerMonth} bulan ini · {p.billingMode === 'internal-quota' ? 'biaya upstream tidak dilaporkan' : `estimasi biaya hari ini ${money(p.spentTodayUsd)}`}</small>{p.capabilities && <p>Text: {p.capabilities.text ? '✓' : '×'} · tools: {p.capabilities.tools ? '✓' : '×'} · structured: {p.capabilities.structured ? '✓' : '×'} · usage: {p.capabilities.usage ? '✓' : '×'}<br />{p.capabilities.errors.join(' · ')}</p>}<div className="actions"><button onClick={() => { setEditing(p); setConfig(p); setSecret(''); setHeaders(''); setAuthHeader(''); }}>Edit</button><button disabled={busy} onClick={() => void action(() => secure(`/providers/${p.id}/probe`, {}))}>Probe</button><button disabled={busy} onClick={() => void action(async () => setModels(await api(`/providers/${p.id}/models`)))}>Temukan model</button><button className="danger" disabled={busy} onClick={() => {
                if (confirm(`Nonaktifkan provider ${p.name}? Lepaskan assignment lebih dahulu. Riwayat tetap tersimpan.`))
                    void action(() => secure(`/providers/${p.id}`, undefined, 'DELETE'));
            }}>Nonaktifkan</button></div></article>)}{models != null && <pre className="record">{JSON.stringify(models, null, 2)}</pre>}<fieldset><legend>{editing ? 'EDIT PROVIDER' : 'PROVIDER BARU'}</legend><div className="form-grid"><label>Nama<input value={config.name} onChange={e => setConfig({ ...config, name: e.target.value })}/></label><label>Protokol<select value={config.protocol} onChange={e => setConfig({ ...config, protocol: e.target.value as ProviderConfig['protocol'] })}>{ProviderProtocolSchema.options.map(p => <option key={p} value={p}>{providerLabels[p]}</option>)}</select></label><label className="wide">Endpoint API<input type="url" placeholder={config.protocol === 'custom-responses' ? 'https://gateway.example/v1/responses' : 'https://gateway.example/v1'} value={config.endpoint ?? ''} onChange={e => setConfig({ ...config, endpoint: e.target.value })}/><small>{providerEndpointHint(config.protocol)}</small></label><label>Model<input value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })}/></label><ProviderUsageFields config={config} onChange={setConfig}/><label>API key<input type="password" autoComplete="new-password" value={secret} placeholder={editing?.hasSecret ? 'Kosong = pertahankan secret' : ''} onChange={e => setSecret(e.target.value)}/></label><label>Custom auth header<input value={authHeader} onChange={e => setAuthHeader(e.target.value)}/></label><label className="wide">Custom headers (JSON; nilai dirahasiakan)<textarea value={headers} onChange={e => setHeaders(e.target.value)} placeholder={'{"x-tenant-id":"workspace-saya"}'}/></label></div><label className="check"><input type="checkbox" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })}/>Aktifkan provider</label><div className="actions"><button className="primary" disabled={busy} onClick={() => void action(async () => { const parsed = ProviderConfigSchema.parse({...config,inputPricePerMillion:config.inputPricePerMillion||undefined,outputPricePerMillion:config.outputPricePerMillion||undefined}); const secrets = secret || headers || authHeader ? { apiKey: secret || undefined, authHeader: authHeader || undefined, headers: headers ? JSON.parse(headers) : {} } : undefined; await secure(editing ? `/providers/${editing.id}` : '/providers', { config: parsed, ...(editing ? { expectedVersion: editing.version, ...(secrets ? { secrets:ProviderSecretsSchema.parse(secrets) } : {}) } : { secrets: ProviderSecretsSchema.parse(secrets ?? { headers: {} }) }) }, editing ? 'PUT' : 'POST'); setEditing(null); setConfig(blank); setSecret(''); setHeaders(''); setAuthHeader(''); })}>Simpan provider</button><button onClick={() => { setEditing(null); setConfig(blank); setSecret(''); setHeaders(''); setAuthHeader(''); }}>Reset form</button></div></fieldset><fieldset><legend>MODEL ASSIGNMENT</legend>{assignments.map(a => <p className="mono" key={a.role}>{a.role}: {query.data?.find(p => p.id === a.primaryId)?.name ?? a.primaryId}  /  fallback {a.fallbackEnabled ? `${a.fallbackIds.length} provider` : "off"}</p>)}<label>Role<select value={role} onChange={e => {const next=e.target.value as ModelAssignment['role'];const assignment=assignments.find(a=>a.role===next);setRole(next);setPrimary(assignment?.primaryId??'');setFallback(assignment?.fallbackEnabled??false);setFallbackIds(assignment?.fallbackIds??[])}}>{['research', 'forecast', 'evidence', 'summary'].map(r => <option key={r}>{r}</option>)}</select></label><label>Provider utama<select value={primary} onChange={e => { setPrimary(e.target.value); setFallbackIds(ids => ids.filter(id => id !== e.target.value)); }}><option value="">Pilih provider</option>{query.data?.map(p => <option value={p.id} key={p.id}>{p.name} / {p.model}</option>)}</select></label><label className="check"><input type="checkbox" checked={fallback} onChange={e => setFallback(e.target.checked)}/>Izinkan fallback eksplisit</label>{fallback && query.data?.filter(p => p.id !== primary).map(p => <label className="check" key={p.id}><input type="checkbox" checked={fallbackIds.includes(p.id)} onChange={e => setFallbackIds(e.target.checked ? [...fallbackIds, p.id] : fallbackIds.filter(id => id !== p.id))}/>{p.name}</label>)}<button disabled={busy || !primary} onClick={() => void action(() => secure('/assignments', AssignmentSchema.parse({ role, primaryId: primary, fallbackEnabled: fallback, fallbackIds: fallback ? fallbackIds.filter(id => id !== primary) : [] }), 'PUT'))}>Simpan assignment</button></fieldset></div>;
}
