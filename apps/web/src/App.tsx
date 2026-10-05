import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { Login } from './auth-ui';
import { TradingProvider } from './TradingContext';
import { TradingLayout } from './TradingLayout';
import Overview from './pages/Overview';

const Records = lazy(() => import('./pages/Records').then(module => ({ default: module.Records })));
const SettingsPage = lazy(() => import('./pages/Records').then(module => ({ default: module.SettingsPage })));
const News = lazy(() => import('./pages/Records').then(module => ({ default: module.News })));
const Performance = lazy(() => import('./pages/Analytics').then(module => ({ default: module.Performance })));
const Evaluation = lazy(() => import('./pages/Analytics').then(module => ({ default: module.Evaluation })));
const Replay = lazy(() => import('./pages/Analytics').then(module => ({ default: module.Replay })));
const Agents = lazy(() => import('./pages/Operations').then(module => ({ default: module.Agents })));
const Health = lazy(() => import('./pages/Operations').then(module => ({ default: module.Health })));
const ActivityLog = lazy(() => import('./pages/Operations').then(module => ({ default: module.ActivityLog })));
const Terminal = lazy(() => import('./pages/Terminal'));
const Latency = lazy(() => import('./pages/Latency'));
const Research = lazy(() => import('./pages/Research'));

export function App() {
  const client = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<{ user?: { email: string } } | null>('/auth/get-session'), retry: false });
  if (session.isPending) return <main className="login"><span className="brand">P<span>/</span>M</span><p role="status">Memeriksa sesi owner…</p></main>;
  if (session.error) return <main className="login"><p className="error">Server tidak dapat dihubungi: {session.error.message}</p><button onClick={() => void session.refetch()}>Coba lagi</button></main>;
  if (!session.data?.user) return <Login onSuccess={() => void client.invalidateQueries({ queryKey: ['session'] })}/>;
  return <TradingProvider><Suspense fallback={<div className="page-loading" role="status">Memuat halaman…</div>}><Routes>
    <Route element={<TradingLayout email={session.data.user.email}/>}>
      <Route index element={<Overview/>}/>
      <Route path="portfolio" element={<Navigate to="/portfolio/positions" replace/>}/>
      <Route path="portfolio/positions" element={<Records name="positions"/>}/>
      <Route path="portfolio/orders" element={<Records name="orders"/>}/>
      <Route path="portfolio/history" element={<Records name="history"/>}/>
      <Route path="markets" element={<Navigate to="/markets/opportunities" replace/>}/>
      <Route path="markets/opportunities" element={<Records name="opportunities"/>}/>
      <Route path="markets/decisions" element={<Records name="decisions"/>}/>
      <Route path="markets/terminal" element={<Terminal/>}/>
      <Route path="analytics" element={<Navigate to="/analytics/performance" replace/>}/>
      <Route path="analytics/performance" element={<Performance/>}/>
      <Route path="analytics/evaluation" element={<Evaluation/>}/>
      <Route path="analytics/replay" element={<Replay/>}/>
      <Route path="research" element={<Navigate to="/research/news" replace/>}/>
      <Route path="research/news" element={<News/>}/>
      <Route path="research/forecasts" element={<Records name="forecasts"/>}/>
      <Route path="research/workspace" element={<Research/>}/>
      <Route path="system" element={<Navigate to="/system/agents" replace/>}/>
      <Route path="system/agents" element={<Agents/>}/>
      <Route path="system/health" element={<Health/>}/>
      <Route path="system/latency" element={<Latency/>}/>
      <Route path="system/activity" element={<ActivityLog/>}/>
      <Route path="system/invocations" element={<Records name="invocations"/>}/>
      <Route path="system/tools" element={<Records name="tools"/>}/>
      <Route path="settings" element={<Navigate to="/settings/risk" replace/>}/>
      <Route path="settings/risk" element={<SettingsPage section="Risiko"/>}/>
      <Route path="settings/providers" element={<SettingsPage section="Provider AI"/>}/>
      <Route path="settings/services" element={<SettingsPage section="Layanan"/>}/>
      <Route path="settings/wallet" element={<SettingsPage section="Wallet"/>}/>
      <Route path="*" element={<section className="panel empty"><h2>Halaman tidak ditemukan</h2><Link className="button" to="/">Kembali ke ringkasan</Link></section>}/>
    </Route>
  </Routes></Suspense></TradingProvider>;
}
