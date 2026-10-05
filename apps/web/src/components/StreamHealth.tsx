import { Link } from 'react-router';
import { useMarketStream } from '../market-stream';
import { FEED_IDLE_TIMEOUT_MS, quoteFresh } from '../../../../packages/shared/src/realtime';

export function StreamHealth() {
  const { data, now, serverNow, error } = useMarketStream();
  const online = !!data?.transportOnline && data.status.connected && now - data.deliveredAt < 5000 && !!data.status.lastEventAt && serverNow - data.status.lastEventAt < FEED_IDLE_TIMEOUT_MS;
  const fresh = data?.quotes.filter(quote=>quoteFresh(quote,serverNow)).length??0;
  return <div className="stream-health"><span className={`connection ${online ? 'online' : ''}`}><i/>{online ? 'WebSocket terhubung' : 'Stream terputus / menunggu'}</span><span>{fresh}/{data?.status.tokens.length ?? 0} harga ≤2 detik</span><span title="Umur timestamp event saat diterima worker; book awal dapat berisi harga yang sudah lama tidak berubah. Ini bukan pengukuran murni latensi jaringan.">Umur event saat diterima {data?.status.exchangeLagMs == null ? '—' : `${Math.round(data.status.exchangeLagMs)} ms`}</span><Link to="/system/latency">Detail latensi</Link>{error && <small className="error">{error.message}</small>}</div>;
}
