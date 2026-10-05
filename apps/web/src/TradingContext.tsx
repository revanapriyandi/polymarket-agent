import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DashboardSnapshot } from '../../../packages/shared/src/index';
import { api } from './api';
import { Reauth } from './auth-ui';
import type { SecureWrite } from './Settings';
import type { StreamUpdate } from '../../../packages/shared/src/realtime';
import type { ClientStream } from './market-stream';

interface TradingState {
  snapshot?: DashboardSnapshot;
  pending: boolean;
  queryError: string | null;
  online: boolean;
  stale: boolean;
  busy: boolean;
  actionError: string;
  secure: SecureWrite;
  control: (action: string) => Promise<void>;
  refresh: () => void;
}
const TradingContext = createContext<TradingState | null>(null);
export function useTrading() {
  const state = useContext(TradingContext);
  if (!state) throw new Error('Trading context unavailable');
  return state;
}
export function TradingProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardSnapshot>('/dashboard'), refetchInterval: 30000 });
  const [online, setOnline] = useState(false), [busy, setBusy] = useState(false), [actionError, setActionError] = useState(''), [stepUp, setStepUp] = useState(false);
  const resolver = useRef<{ resolve: (token: string) => void; reject: (error: Error) => void } | null>(null);
  useEffect(() => {
    const stream = new EventSource('/api/events', { withCredentials: true });
    const disconnectMarket = () => client.setQueryData<ClientStream>(['market-stream'], previous => previous ? { ...previous, transportOnline: false } : previous);
    stream.onerror = () => { setOnline(false); disconnectMarket(); };
    stream.addEventListener('market-unavailable', disconnectMarket);
    stream.addEventListener('quotes', event => {
      try {
        const update: StreamUpdate = JSON.parse((event as MessageEvent).data);
        client.setQueryData<ClientStream>(['market-stream'], previous => {
          const quotes = new Map(previous?.status.epoch === update.status.epoch ? previous.quotes.map(quote => [quote.tokenId, quote]) : []);
          for (const quote of update.quotes) { const old = quotes.get(quote.tokenId); if (!old || quote.receivedAt >= old.receivedAt) quotes.set(quote.tokenId, quote); }
          return { ...update, quotes: [...quotes.values()].filter(quote => update.status.tokens.includes(quote.tokenId)), deliveredAt: Date.now(), transportOnline: true };
        });
      } catch { disconnectMarket(); }
    });
    stream.addEventListener('unavailable', () => setOnline(false));
    stream.addEventListener('snapshot', event => {
      try { client.setQueryData(['dashboard'], JSON.parse((event as MessageEvent).data)); setOnline(true); }
      catch { setOnline(false); }
    });
    return () => { stream.close(); disconnectMarket(); resolver.current?.reject(new Error('Sesi ditutup')); resolver.current = null; };
  }, [client]);
  const secure: SecureWrite = useCallback(async (path, body, method) => {
    if (resolver.current) throw new Error('Selesaikan verifikasi yang sedang terbuka terlebih dahulu');
    const token = await new Promise<string>((resolve, reject) => { resolver.current = { resolve, reject }; setStepUp(true); });
    return api(path, body, method, token);
  }, []);
  async function control(action: string) {
    const confirmations: Record<string, string> = { pause: 'Jeda operasi dan antrekan pembatalan order terbuka?', resume: 'Lanjutkan operasi sesuai profil risiko aktif?', emergency: 'Emergency stop: hentikan entry dan batalkan order terbuka?', paper: 'Pindah ke mode paper?', 'activate-live': 'Aktifkan trading dengan dana nyata? Semua persyaratan kesiapan dan evaluasi harus lulus.' };
    if (!confirm(confirmations[action])) return;
    setBusy(true); setActionError('');
    try { await secure('/control', { action }); await query.refetch(); }
    catch (error) { setActionError((error as Error).message); }
    finally { setBusy(false); }
  }
  const stale = !!query.data && Date.now() - Date.parse(query.data.at) > 90000;
  return <TradingContext.Provider value={{ snapshot: query.data, pending: query.isPending, queryError: query.error?.message ?? null, online, stale, busy, actionError, secure, control, refresh: () => void query.refetch() }}>
    {children}
    {stepUp && <Reauth onClose={() => { resolver.current?.reject(new Error('Verifikasi dibatalkan')); resolver.current = null; setStepUp(false); }} onToken={token => { resolver.current?.resolve(token); resolver.current = null; setStepUp(false); }}/>}
  </TradingContext.Provider>;
}
