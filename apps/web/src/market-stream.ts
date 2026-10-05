import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StreamUpdate } from '../../../packages/shared/src/realtime';
import { api } from './api';

export interface ClientStream extends StreamUpdate { deliveredAt: number; transportOnline: boolean }
export function useMarketStream() {
  const query = useQuery<ClientStream>({ queryKey: ['market-stream'], queryFn: async () => ({ ...await api<StreamUpdate>('/market-stream'), deliveredAt: Date.now(), transportOnline: true }), staleTime: Infinity });
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(interval); }, []);
  const serverNow = query.data ? query.data.publishedAt + Math.max(0, now-query.data.deliveredAt) : now;
  return { ...query, now, serverNow };
}
