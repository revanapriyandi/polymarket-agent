import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, Search, ArrowUpRight } from 'lucide-react';
import type { TableName, TablePage, Mode } from '../../../packages/shared/src/index';
import { api } from './api';
import { Drawer } from './Drawer';
import { tableColumns, tableNames, display } from './table-columns';
import type { SecureWrite } from './Settings';

const statuses: Partial<Record<TableName, string[]>> = {
  positions: ['open', 'recovery', 'pending-resolution', 'disputed', 'closed'],
  orders: ['approved', 'preparing', 'submitting', 'open', 'partial', 'settling', 'ambiguous', 'recovery', 'filled', 'cancelled', 'expired', 'rejected', 'failed'],
  opportunities: ['candidate', 'rejected', 'expired'], invocations: ['running', 'complete', 'failed'],
};
export function DataTable({ name, secure, mode, compact = false }: { name: TableName; secure: SecureWrite; mode: Mode; compact?: boolean }) {
  const [page, setPage] = useState(1), [search, setSearch] = useState(''), [status, setStatus] = useState(''), [activeOnly, setActiveOnly] = useState(compact);
  const [selected, setSelected] = useState<string | null>(null), [sort, setSort] = useState<{ key: string; ascending: boolean } | null>(null);
  const pageSize = compact ? 5 : 15;
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), search, status, activeOnly: String(activeOnly) });
  const query = useQuery({ queryKey: ['table', mode, name, page, pageSize, search, status, activeOnly], queryFn: () => api<TablePage>(`/table/${name}?${params}`), refetchInterval: 15000 });
  const columns = compact ? tableColumns[name].filter(c => ['question', 'shares', 'positionValue', 'unrealizedPnl', 'status'].includes(c.key)) : tableColumns[name];
  const sortColumn = columns.find(column => column.key === sort?.key);
  const rows = [...(query.data?.rows ?? [])].sort((a, b) => sort && sortColumn ? display(sortColumn.value(a)).localeCompare(display(sortColumn.value(b)), 'id', { numeric: true }) * (sort.ascending ? 1 : -1) : 0);
  return <section className={`panel data-panel ${compact ? 'compact-table' : ''}`}>
    {compact ? <div className="table-heading"><div><h2>Posisi aktif <span className="count">{query.data?.total ?? '—'}</span></h2><small>Posisi dengan saham yang masih dimiliki.</small></div><Link className="inline-link" to="/portfolio/positions">Lihat portofolio <ArrowUpRight size={14}/></Link></div> : <>
      <div className="table-toolbar"><label className="search"><Search size={15}/><input aria-label="Cari data" placeholder="Cari nama market, ID, atau alasan…" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
        {statuses[name] && <select aria-label="Filter status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">Semua status</option>{statuses[name]?.map(value => <option key={value}>{value}</option>)}</select>}
        {name === 'positions' && <label className="check"><input type="checkbox" checked={activeOnly} onChange={event => { setActiveOnly(event.target.checked); setPage(1); }}/>Hanya posisi aktif</label>}
        <a className="button" href={`/api/table/${name}/export?${params}`}><Download size={14}/>Ekspor CSV</a>
      </div>
      <p className="table-units">{name === 'tools' || name === 'forecasts' ? 'Riset lintas mode. Profil dan sumber lengkap tersedia di detail.' : name === 'invocations' ? 'Biaya dalam USD. Nilai kosong berarti penggunaan belum dapat dihitung; cadangan biaya ada di detail.' : `Mode ${mode} · nilai & harga dalam pUSD · ukuran dalam saham.`} Ekspor dibatasi 10.000 baris.</p>
    </>}
    {query.error ? <div className="error" role="alert">{query.error.message} <button onClick={() => void query.refetch()}>Coba lagi</button></div> : query.isPending ? <div className="empty" role="status">Memuat {tableNames[name]}…</div> : rows.length ? <div className="table-scroll"><table><thead><tr>{columns.map(column => <th key={column.key} aria-sort={sort?.key === column.key ? (sort.ascending ? 'ascending' : 'descending') : 'none'}><button className="column-sort" aria-label={`Urutkan ${column.title} pada halaman ini`} onClick={() => setSort({ key: column.key, ascending: sort?.key === column.key ? !sort.ascending : true })}>{column.title}{sort?.key === column.key && (sort.ascending ? ' ↑' : ' ↓')}</button></th>)}<th><span className="sr-only">Aksi</span></th></tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map(column => <td className={column.className} key={column.key}>{column.render ? column.render(column.value(row), row) : display(column.value(row))}</td>)}<td>{row.id != null && <button className="text-button" onClick={() => setSelected(String(row.id))} aria-label={`Detail ${display(row.question ?? row.id)}`}>Detail <ArrowUpRight size={13}/></button>}</td></tr>)}</tbody></table></div> : <div className="empty table-empty"><strong>{search || status ? 'Tidak ada hasil untuk filter ini' : `Belum ada ${compact ? 'posisi aktif' : tableNames[name]}`}</strong><small>{search || status ? 'Ubah pencarian atau status untuk melihat data lainnya.' : name === 'positions' ? 'Posisi muncul setelah order terisi. Dana tersedia tetap bisa dipantau pada ringkasan.' : 'Data akan tampil setelah aktivitas tercatat.'}</small>{compact && <Link to="/markets/opportunities" className="inline-link">Lihat peluang pasar <ArrowUpRight size={14}/></Link>}</div>}
    {!compact && <footer className="section-head"><span>{query.data?.total ?? 0} record · halaman {page} dari {Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize))}{sort && ' · urutan pada halaman ini'}</span><div className="actions"><button aria-label="Halaman sebelumnya" disabled={page === 1 || query.isFetching} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15}/></button><button aria-label="Halaman berikutnya" disabled={query.isFetching || page * pageSize >= (query.data?.total ?? 0)} onClick={() => setPage(value => value + 1)}><ChevronRight size={15}/></button></div></footer>}
    {selected && <RecordDetail name={name} id={selected} onClose={() => setSelected(null)} secure={secure}/>}
  </section>;
}
function RecordDetail({ name, id, onClose, secure }: { name: TableName; id: string; onClose: () => void; secure: SecureWrite }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['detail', name, id], queryFn: () => api<Record<string, unknown>>(`/detail/${name}/${encodeURIComponent(id)}`) });
  const [price, setPrice] = useState(''), [shares, setShares] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function act(replace: boolean) {
    if (!confirm(replace ? 'Ganti harga dan jumlah order ini?' : 'Batalkan order ini?')) return;
    setBusy(true); setError('');
    try {
      await secure(`/orders/${encodeURIComponent(id)}/${replace ? 'replace' : 'cancel'}`, replace ? { price, shares } : {});
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['table'] }), client.invalidateQueries({ queryKey: ['chart-orders'] }), client.invalidateQueries({ queryKey: ['dashboard'] })]);
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  const orderOpen = ['approved', 'preparing', 'open', 'partial'].includes(String(query.data?.status));
  return <Drawer title={`Detail ${tableNames[name]}`} onClose={onClose}>
    {query.isPending ? <p>Memuat detail…</p> : query.error ? <p className="error" role="alert">{query.error.message}</p> : query.data && <>
      <dl className="detail-record">{tableColumns[name].map(column => <div key={column.key}><dt>{column.title}</dt><dd>{column.render ? column.render(column.value(query.data!), query.data!) : display(column.value(query.data!))}</dd></div>)}</dl>
      <details className="audit-detail"><summary>Data lengkap & audit</summary><pre>{JSON.stringify(query.data, null, 2)}</pre></details>
    </>}
    {name === 'orders' && orderOpen && <fieldset><legend>Kelola order</legend><p className="muted">Harga dan ukuran pengganti tetap diperiksa oleh Risk Guardian.</p><div className="form-grid"><label>Harga baru (pUSD)<input type="number" min="0.001" max="0.999" step="0.001" value={price} onChange={event => setPrice(event.target.value)}/></label><label>Saham<input type="number" min="0.000001" step="0.000001" value={shares} onChange={event => setShares(event.target.value)}/></label></div><div className="actions"><button disabled={busy || Number(price) <= 0 || Number(price) >= 1 || Number(shares) <= 0} onClick={() => void act(true)}>Ganti order</button><button disabled={busy} className="danger" onClick={() => void act(false)}>Batalkan order</button></div>{error && <p className="error" role="alert">{error}</p>}</fieldset>}
  </Drawer>;
}
