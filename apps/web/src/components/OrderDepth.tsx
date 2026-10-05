import type { MarketQuote } from '../../../../packages/shared/src/realtime';
import type { OrderBook } from '../../../../packages/shared/src/index';
import { date, percent } from '../api';

export function OrderDepth({ quote, book, now, connected, outcome, error }: { quote?: MarketQuote; book?: OrderBook; now: number; connected: boolean; outcome: string; error?: string }) {
  const streamed = quote?.depth;
  const live = connected && streamed?.exchangeAt != null && now-streamed.exchangeAt < 2000 && now-streamed.receivedAt < 2000;
  const levels = live ? streamed : book;
  const maxSize = Math.max(1,...[...(levels?.asks.slice(0,8)??[]),...(levels?.bids.slice(0,8)??[])].map(row=>Number(row.size)));
  return <section className="panel order-depth">
    <div className="section-head"><h2>Order book · {outcome}</h2><span className={`badge ${live?'ready':'degraded'}`}>{live?'Streaming':'Snapshot REST'}</span></div>
    <small>{live?`Pembaruan ${Math.max(0,now-streamed!.exchangeAt!)} ms lalu · 15 level teratas`:`Observasi ${date(book?.observedAt)}. Menunggu kedalaman streaming yang segar; snapshot REST diperbarui setiap 5 detik.`}</small>
    {error&&!live&&<p className="error">{error}</p>}
    <div className="depth-heading"><span>Harga</span><span>Saham</span><span>Total pUSD</span></div>
    {(['asks','bids'] as const).map(side=><div key={side}>{levels?.[side].slice(0,8).map(row=><div key={row.price} className={`depth-row ${side}`} style={{backgroundImage:`linear-gradient(to left,${side==='asks'?'#da817318':'#54d6b91c'} ${Math.min(100,Number(row.size)/maxSize*100)}%,transparent 0)`}}><span>{percent(row.price)}</span><span>{Number(row.size).toLocaleString('en-US',{maximumFractionDigits:2})}</span><span>{(Number(row.price)*Number(row.size)).toFixed(2)}</span></div>)}</div>)}
    {!levels&&<div className="empty">Menunggu kedalaman order book</div>}
  </section>;
}
