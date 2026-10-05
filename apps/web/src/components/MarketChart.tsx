import { useEffect, useRef, useState } from 'react';
import { LineSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { percent } from '../api';
import type { MarketQuote } from '../../../../packages/shared/src/realtime';

export interface PricePoint { time: number; value: number }
export function MarketChart({ identity, points, comparison, compareLabel, quote, showAverage }: { identity: string; points: PricePoint[]; comparison: PricePoint[]; compareLabel?: string; quote?: MarketQuote; showAverage: boolean }) {
  const container = useRef<HTMLDivElement>(null), instance = useRef<{ chart: IChartApi; price: ISeriesApi<'Line'>; comparison: ISeriesApi<'Line'>; average: ISeriesApi<'Line'> } | null>(null);
  const [hover, setHover] = useState<{ time: string; price: number } | null>(null);
  const lastTime = useRef(0);
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, { autoSize: true, height: 420, layout: { background: { type: ColorType.Solid, color: '#10181d' }, textColor: '#91a5b2', fontFamily: 'Consolas, monospace' }, grid: { vertLines: { color: '#24333e44' }, horzLines: { color: '#24333e66' } }, timeScale: { timeVisible: true, secondsVisible: true, borderColor: '#263842', shiftVisibleRangeOnNewBar: false }, rightPriceScale: { borderColor: '#263842' }, crosshair: { mode: 0, vertLine: { color: '#7293a8' }, horzLine: { color: '#7293a8' } }, localization: { priceFormatter: (value: number) => percent(value) } });
    const price = chart.addSeries(LineSeries, { color: '#57d4b7', lineWidth: 2, title: 'Probabilitas', priceFormat: { type: 'custom', minMove: .0001, formatter: percent } });
    const comparison = chart.addSeries(LineSeries, { color: '#9a9aff', lineWidth: 1, priceLineVisible: false, title: 'Pembanding' });
    const average = chart.addSeries(LineSeries, { color: '#e8bc71', lineWidth: 1, lineStyle: 2, priceLineVisible: false, title: 'SMA 20 sampel' });
    instance.current = { chart, price, comparison, average };
    chart.subscribeCrosshairMove(event => { const row = event.seriesData.get(price); setHover(row && 'value' in row ? { price: row.value, time: typeof event.time === 'number' ? new Date(event.time * 1000).toLocaleString('id-ID') : '' } : null); });
    return () => { instance.current = null; chart.remove(); };
  }, []);
  useEffect(() => {
    const current = instance.current; if (!current) return;
    const clean = [...new Map(points.filter(p => Number.isFinite(p.time) && Number.isFinite(p.value)).map(p => [p.time, p])).values()].sort((a,b) => a.time-b.time);
    current.price.setData(clean.map(p => ({ ...p, time: p.time as UTCTimestamp })));
    current.average.setData(clean.flatMap((p, i) => i < 19 ? [] : [{ time: p.time as UTCTimestamp, value: clean.slice(i-19,i+1).reduce((sum,row) => sum+row.value,0)/20 }]));
    lastTime.current = clean.at(-1)?.time ?? 0;
    if (clean.length) current.chart.timeScale().fitContent();
  }, [points, identity]);
  useEffect(() => { instance.current?.comparison.setData(comparison.map(p => ({ ...p, time: p.time as UTCTimestamp }))); instance.current?.comparison.applyOptions({ title: compareLabel ?? 'Pembanding' }); }, [comparison, compareLabel]);
  useEffect(() => { instance.current?.average.applyOptions({ visible: showAverage }); }, [showAverage]);
  useEffect(() => {
    if (!quote?.bid || !quote.ask || !quote.exchangeAt || !instance.current) return;
    const time = Math.floor(quote.exchangeAt / 1000); if (time < lastTime.current) return;
    instance.current.price.update({ time: time as UTCTimestamp, value: (Number(quote.bid)+Number(quote.ask))/2 }); lastTime.current = time;
  }, [quote, identity]);
  return <><div className="market-chart-legend"><span>{hover ? `${hover.time} · ${percent(hover.price)}` : 'Probabilitas · harga historis / midpoint bid–ask saat streaming'}</span><button className="text-button" onClick={() => instance.current?.chart.timeScale().fitContent()}>Reset zoom</button><button className="text-button" onClick={() => { const canvas=instance.current?.chart.takeScreenshot(); if(canvas){const anchor=document.createElement('a');anchor.href=canvas.toDataURL('image/png');anchor.download=`polymarket-${identity}.png`;anchor.click();} }}>Unduh grafik</button></div><div ref={container} className="market-chart" role="img" aria-label="Grafik probabilitas pasar dengan crosshair, zoom, dan perbandingan"/></>;
}
