import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import type { TableName, TablePage, Mode } from '../../../packages/shared/src/index';
import { api, label } from './api';
import { Drawer } from './Drawer';
import type { SecureWrite } from './Settings';
const names: Record<TableName, string> = { positions: 'Posisi', orders: 'Orders', opportunities: 'Peluang', decisions: 'Keputusan', history: 'Riwayat', invocations: 'AI calls', tools: 'Tools', forecasts: 'Forecasts' };
const statuses: Partial<Record<TableName, string[]>> = {
    positions: ['open', 'recovery', 'pending-resolution', 'disputed', 'closed'],
    orders: ['approved', 'preparing', 'submitting', 'open', 'partial', 'settling', 'ambiguous', 'recovery', 'filled', 'cancelled', 'expired', 'rejected', 'failed'],
    opportunities: ['candidate', 'rejected'],
    invocations: ['running', 'complete', 'failed'],
};
function display(value: unknown): string { if (value == null)
    return '—'; if (typeof value === 'object')
    return JSON.stringify(value); return String(value); }
export function DataTable({ secure, mode }: {
    secure: SecureWrite;
    mode: Mode;
}) {
    const [name, setName] = useState<TableName>('positions');
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [sort, setSort] = useState<{
        key: string;
        ascending: boolean;
    } | null>(null);
    const query = useQuery({ queryKey: ['table', mode, name, page, search, status], queryFn: () => api<TablePage>(`/table/${name}?${new URLSearchParams({ page: String(page), pageSize: '12', search, status })}`), refetchInterval: 15000 });
    const rows = [...(query.data?.rows ?? [])].sort((a, b) => sort ? display(a[sort.key]).localeCompare(display(b[sort.key]), 'id', { numeric: true }) * (sort.ascending ? 1 : -1) : 0);
    const columns = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => !['id', 'raw', 'metadata', 'request', 'response', 'intent', 'signedPayload', 'mode', 'rulesHash', 'profileVersion'].includes(k)).slice(0, 7);
    return <section className="panel data-panel"><div className="tabs table-tabs" aria-label="Jenis data">{Object.entries(names).map(([key, value]) => <button key={key} aria-pressed={name === key} className={name === key ? 'selected' : ''} onClick={() => { setName(key as TableName); setPage(1); setStatus(''); setSort(null); setSelected(null); }}>{value}</button>)}</div><p className="table-units">{name==='tools'||name==='forecasts'?'Riset dan tools lintas mode; lihat input, profil, dan mode pada detail. Tidak menunjukkan hasil uang nyata.':name==='invocations'?'Biaya AI: USD estimasi; unknown-reserved = biaya maksimum masih dicadangkan.':`Mode ${mode} · collateral/harga/notional: pUSD · jumlah: shares · probabilitas: 0–1. Paper menggunakan saldo virtual.`}</p><div className="table-toolbar"><label className="search"><Search size={15}/><input aria-label="Cari data" placeholder="Cari market, ID, atau alasan…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label>{statuses[name] && <select aria-label="Filter status" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">Semua status</option>{statuses[name]?.map(s => <option key={s}>{s}</option>)}</select>}<a className="button" href={`/api/table/${name}/export?${new URLSearchParams({ search, status })}`}><Download size={14}/> CSV · maks. 10.000</a></div>{query.error ? <div className="error" role="alert">{query.error.message}<button onClick={() => void query.refetch()}>Coba lagi</button></div> : query.isPending ? <div className="empty" role="status">Memuat data…</div> : rows.length ? <div className="table-scroll"><table><thead><tr>{columns.map(c => <th key={c} aria-sort={sort?.key === c ? (sort.ascending ? 'ascending' : 'descending') : 'none'}><button className="text-button" aria-label={`Urutkan ${label(c)} pada halaman ini`} onClick={() => setSort({ key: c, ascending: sort?.key === c ? !sort.ascending : true })}>{label(c)} {sort?.key === c ? (sort.ascending ? '↑' : '↓') : '↕'}</button></th>)}<th>Aksi</th></tr></thead><tbody>{rows.map((row, i) => <tr key={String(row.id ?? i)}>{columns.map(c => <td key={c} title={display(row[c])}>{['status', 'state', 'strategy', 'side'].includes(c) ? <span className={'badge ' + String(row[c])}>{display(row[c])}</span> : display(row[c])}</td>)}<td>{row.id != null ? <button className="text-button" onClick={() => setSelected(String(row.id))}>Detail ↗</button> : '—'}</td></tr>)}</tbody></table></div> : <div className="empty"><strong>Belum ada {names[name].toLowerCase()}</strong><small>{search || status ? 'Tidak ada hasil untuk filter ini.' : 'Data akan muncul setelah operasi aktual tercatat.'}</small></div>}<footer className="section-head"><span>{query.data?.total ?? 0} record · halaman {page} · urutan per halaman</span><div className="actions"><button aria-label="Halaman sebelumnya" disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}><ChevronLeft size={15}/></button><button aria-label="Halaman berikutnya" disabled={query.isFetching || page * 12 >= (query.data?.total ?? 0)} onClick={() => setPage(page + 1)}><ChevronRight size={15}/></button></div></footer>{selected && <RecordDetail name={name} id={selected} onClose={() => setSelected(null)} secure={secure}/>}</section>;
}
function RecordDetail({ name, id, onClose, secure }: {
    name: TableName;
    id: string;
    onClose: () => void;
    secure: SecureWrite;
}) {
    const client = useQueryClient();
    const query = useQuery({ queryKey: ['detail', name, id], queryFn: () => api<Record<string, unknown>>(`/detail/${name}/${encodeURIComponent(id)}`) });
    const [price, setPrice] = useState('');
    const [shares, setShares] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    async function act(replace: boolean) { if (!confirm(replace ? 'Ganti harga dan jumlah order ini?' : 'Batalkan order ini?'))
        return; try {
        setBusy(true);
        setError('');
        await secure(`/orders/${encodeURIComponent(id)}/${replace ? 'replace' : 'cancel'}`, replace ? { price, shares } : {});
        await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['table', 'orders'] }), client.invalidateQueries({ queryKey: ['chart-orders'] }), client.invalidateQueries({ queryKey: ['dashboard'] })]);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    const orderOpen = ['approved', 'preparing', 'open', 'partial'].includes(String(query.data?.status));
    return <Drawer title={`${names[name]} / ${id}`} onClose={onClose}>{query.isPending ? <p>Memuat detail…</p> : query.error ? <p className="error" role="alert">{query.error.message}</p> : <dl className="detail-record">{Object.entries(query.data ?? {}).filter(([key]) => key !== 'signedPayload').map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{typeof value === 'object' ? <pre>{JSON.stringify(value, null, 2)}</pre> : display(value)}</dd></div>)}</dl>}{name === 'orders' && orderOpen && <fieldset><legend>ORDER CONTROL</legend><p className="muted">Server memvalidasi status order dan izin aksi sebelum eksekusi.</p><div className="form-grid"><label>Harga baru<input type="number" min="0.001" max="0.999" step="0.001" value={price} onChange={e => setPrice(e.target.value)}/></label><label>Shares<input type="number" min="0.000001" step="0.000001" value={shares} onChange={e => setShares(e.target.value)}/></label></div><div className="actions"><button disabled={busy || Number(price) <= 0 || Number(price) >= 1 || Number(shares) <= 0} onClick={() => void act(true)}>Replace order</button><button disabled={busy} className="danger" onClick={() => void act(false)}>Cancel order</button></div>{error && <p className="error" role="alert">{error}</p>}</fieldset>}</Drawer>;
}
