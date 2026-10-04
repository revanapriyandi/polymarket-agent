import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { ChevronDown, LogOut, Menu, Pause, Play, Square, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { navigation } from './navigation';
import { api } from './api';
import { useTrading } from './TradingContext';

const controlLabels = { running: 'Berjalan', paused: 'Dijeda', emergency: 'Emergency stop', 'risk-stopped': 'Batas risiko tercapai' };
export function TradingLayout({ email }: { email: string }) {
  const location = useLocation(), client = useQueryClient();
  const state = useTrading(), snapshot = state.snapshot;
  const [menuOpen, setMenuOpen] = useState(false), [expanded, setExpanded] = useState<string | null>(null), [logoutError, setLogoutError] = useState('');
  const activeGroup = navigation.find(group => group.pages.some(page => page.path === location.pathname));
  const activePage = activeGroup?.pages.find(page => page.path === location.pathname);
  const title = useRef<HTMLHeadingElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { document.title = `${activePage?.label ?? 'Halaman tidak ditemukan'} · Polymarket`; window.scrollTo(0, 0); title.current?.focus({ preventScroll: true }); }, [location.pathname, activePage?.label]);
  function navigate() { setMenuOpen(false); setExpanded(null); }
  return <div className="trading-shell">
    <a href="#trading-content" className="skip-link">Langsung ke konten</a>
    <aside id="trading-navigation" className={`trading-sidebar ${menuOpen ? 'is-open' : ''}`} onKeyDown={event => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } }}>
      <div className="sidebar-brand"><Link to="/" onClick={navigate} aria-label="Ringkasan Polymarket"><span className="brand">P<span>/</span>M</span><span>Polymarket<small>Trading workspace</small></span></Link><button className="icon mobile-only" aria-label="Tutup menu" onClick={() => { setMenuOpen(false); menuButton.current?.focus(); }}><X size={18}/></button></div>
      <nav aria-label="Menu utama"><span className="nav-caption">Workspace</span>{navigation.map(group => {
        const Icon = group.icon, selected = activeGroup === group, open = expanded === null ? selected : expanded === group.label;
        return <div className="nav-group" key={group.label}>{group.pages.length === 1 ? <NavLink className="nav-parent" to={group.pages[0].path} end onClick={navigate}><Icon size={18}/>{group.label}</NavLink> : <>
          <button className={`nav-parent ${selected ? 'selected' : ''}`} aria-expanded={open} onClick={() => setExpanded(open ? '' : group.label)}><Icon size={18}/><span>{group.label}</span><ChevronDown className={open ? 'rotated' : ''} size={14}/></button>
          {open && <div className="nav-children">{group.pages.map(page => <NavLink key={page.path} to={page.path} onClick={navigate}>{page.label}</NavLink>)}</div>}
        </>}</div>;
      })}</nav>
      <footer className="sidebar-footer"><span className={'connection '+(state.online && !state.stale ? 'online' : '')}><i/>{state.online && !state.stale ? 'Data realtime' : 'Menghubungkan data…'}</span><span className="owner-email" title={email}>{email}</span><button className="text-button" onClick={() => { void api('/auth/sign-out', {}).then(() => { client.setQueryData(['session'], null); client.removeQueries({ predicate: query => query.queryKey[0] !== 'session' }); }).catch(error => setLogoutError(error.message)); }}><LogOut size={14}/>Keluar</button></footer>
    </aside>
    {menuOpen && <button className="nav-scrim" aria-label="Tutup navigasi" onClick={() => setMenuOpen(false)}/>}
    <div className="trading-workspace">
      <header className="trading-topbar"><div className="trading-breadcrumb"><button className="icon mobile-only" ref={menuButton} aria-label="Buka menu" aria-expanded={menuOpen} aria-controls="trading-navigation" onClick={() => setMenuOpen(value => !value)}><Menu size={20}/></button><span>Workspace</span><span>/</span><strong>{activeGroup?.label ?? 'Halaman'}</strong></div><div className="trading-controls">
        {snapshot && <><span className={'mode '+snapshot.mode}>{snapshot.mode === 'paper' ? 'PAPER' : 'LIVE'}</span><span className={`run-status ${snapshot.control}`}>{controlLabels[snapshot.control]}</span><button disabled={state.busy} aria-label={snapshot.control === 'running' ? 'Jeda operasi' : 'Lanjutkan operasi'} onClick={() => void state.control(snapshot.control === 'running' ? 'pause' : 'resume')}>{snapshot.control === 'running' ? <Pause size={14}/> : <Play size={14}/>}<span>{snapshot.control === 'running' ? 'Jeda' : 'Lanjutkan'}</span></button><button className="danger icon" title="Emergency stop" aria-label="Emergency stop" disabled={state.busy || snapshot.control === 'emergency'} onClick={() => void state.control('emergency')}><Square size={14}/></button></>}
      </div></header>
      <main id="trading-content" className="trading-content"><div className="page-heading"><div><h1 ref={title} tabIndex={-1}>{activePage?.label ?? 'Halaman tidak ditemukan'}</h1><p>{activePage?.description ?? 'Pilih halaman lain melalui menu.'}</p></div>{snapshot && <span className="denomination">{snapshot.mode === 'paper' ? 'Simulasi · pUSD virtual' : 'Dana nyata · pUSD'}</span>}</div>
        {activeGroup && activeGroup.pages.length > 1 && <nav className="page-subnav" aria-label={`Submenu ${activeGroup.label}`}>{activeGroup.pages.map(page => <NavLink key={page.path} to={page.path}>{page.label}</NavLink>)}</nav>}
        {(state.actionError || logoutError) && <p className="error" role="alert">{state.actionError || logoutError}</p>}
        {state.stale && <p className="error" role="alert">Data terakhir sudah kedaluwarsa. Periksa koneksi sebelum mengambil keputusan.</p>}
        {state.queryError && <p className="error" role="alert">{state.queryError} <button onClick={state.refresh}>Muat ulang</button></p>}
        {state.pending ? <div className="page-loading" role="status">Memuat data trading…</div> : snapshot ? <Suspense fallback={<div className="page-loading" role="status">Memuat halaman…</div>}><Outlet/></Suspense> : null}
      </main>
    </div>
  </div>;
}
