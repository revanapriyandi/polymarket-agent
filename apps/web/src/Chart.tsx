import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AreaSeries, ColorType, createChart, createSeriesMarkers, type UTCTimestamp, type SeriesMarker, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time } from 'lightweight-charts';
import type { EquityPoint, Mode, TablePage } from '../../../packages/shared/src/index';
import { api, collateral } from './api';
export function EquityChart({ points, mode }: {
    points: EquityPoint[];
    mode: Mode;
}) {
    const container = useRef<HTMLDivElement>(null);
    const [range, setRange] = useState('ALL');
    const [hover, setHover] = useState<number | null>(null);
    const orders = useQuery({ queryKey: ['chart-orders', mode], queryFn: () => api<TablePage>('/table/orders?page=1&pageSize=100&search=&status='), refetchInterval: 30000 });
    const instance = useRef<{ chart: IChartApi; series: ISeriesApi<'Area'>; markers: ISeriesMarkersPluginApi<Time> } | null>(null);
    const plotted = useRef<EquityPoint[]>([]);
    const viewport = useRef<{ mode: Mode; range: string; loaded: boolean } | null>(null);
    const actual = useMemo(() => {
        const seconds = range === '24H' ? 86400 : range === '7D' ? 604800 : range === '30D' ? 2592000 : Infinity;
        const valid = points.filter(p => Number.isFinite(p.time) && p.time >= 0 && Number.isFinite(p.equity));
        const latest = valid.reduce((time, point) => Math.max(time, point.time), 0);
        return [...new Map(valid.filter(p => p.time >= latest - seconds).map(p => [Math.floor(p.time), { ...p, time: Math.floor(p.time) }])).values()].sort((a, b) => a.time - b.time);
    }, [points, range]);
    useEffect(() => {
        if (!container.current) return;
        const chart = createChart(container.current, { autoSize: true, height: 320, layout: { background: { type: ColorType.Solid, color: '#12191c' }, textColor: '#839499', fontFamily: 'Consolas, monospace' }, grid: { vertLines: { color: '#ffffff04' }, horzLines: { color: '#ffffff08' } }, rightPriceScale: { borderColor: '#263337' }, timeScale: { borderColor: '#263337', timeVisible: true, shiftVisibleRangeOnNewBar: false }, crosshair: { vertLine: { color: '#54d6b9' }, horzLine: { color: '#54d6b9' } } });
        const series = chart.addSeries(AreaSeries, { lineColor: '#54d6b9', topColor: '#54d6b92b', bottomColor: '#54d6b902', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: .01 } });
        const markers = createSeriesMarkers(series, []);
        instance.current = { chart, series, markers };
        chart.subscribeCrosshairMove(param => { const row = param.seriesData.get(series); setHover(row && 'value' in row ? row.value : null); });
        return () => { instance.current = null; viewport.current = null; plotted.current = []; markers.detach(); chart.remove(); };
    }, []);
    useEffect(() => {
        const current = instance.current;
        if (!current) return;
        const previous = viewport.current;
        const reset = !previous?.loaded || previous.mode !== mode || previous.range !== range;
        const visible = current.chart.timeScale().getVisibleRange();
        const previousPoints = plotted.current;
        const canUpdate = !reset && previousPoints.length > 0 && actual.length >= previousPoints.length && previousPoints.slice(0, -1).every((point, index) => point.time === actual[index].time && point.equity === actual[index].equity) && previousPoints.at(-1)!.time === actual[previousPoints.length - 1].time;
        if (canUpdate) {
            for (let index = previousPoints.length - 1; index < actual.length; index++) {
                const point = actual[index];
                if (point.time !== previousPoints[index]?.time || point.equity !== previousPoints[index]?.equity) current.series.update({ time: point.time as UTCTimestamp, value: point.equity });
            }
        } else current.series.setData(actual.map(p => ({ time: p.time as UTCTimestamp, value: p.equity })));
        plotted.current = actual;
        if (actual.length) {
            if (reset) current.chart.timeScale().fitContent();
            else if (visible) current.chart.timeScale().setVisibleRange(visible);
        }
        viewport.current = { mode, range, loaded: actual.length > 0 };
    }, [actual, mode, range]);
    useEffect(() => {
        const current = instance.current;
        if (!current) return;
        const markers: SeriesMarker<UTCTimestamp>[] = [];
        for (const order of orders.data?.rows ?? []) {
            if (order.mode !== mode) continue;
            const side = (order.intent as { side?: string } | undefined)?.side ?? order.side;
            if (side !== 'BUY' && side !== 'SELL') continue;
            const timestamp = Date.parse(String(order.createdAt));
            if (!Number.isFinite(timestamp) || !actual.length) continue;
            const time = Math.floor(timestamp / 1000);
            if (time < actual[0].time || time > actual.at(-1)!.time) continue;
            const nearest = actual.reduce((best, p) => Math.abs(p.time - time) < Math.abs(best.time - time) ? p : best, actual[0]);
            markers.push({ time: nearest.time as UTCTimestamp, position: side === 'BUY' ? 'belowBar' : 'aboveBar', color: side === 'BUY' ? '#54d6b9' : '#ef8b81', shape: side === 'BUY' ? 'arrowUp' : 'arrowDown', text: `${side} · ${String(order.status ?? 'order')}` });
        }
        current.markers.setMarkers(markers.sort((a, b) => Number(a.time) - Number(b.time)));
    }, [actual, orders.data, mode]);
    return <section className="panel chart"><div className="section-head"><div><span className="eyebrow">PORTFOLIO PERFORMANCE</span><h2>Kurva ekuitas <span className="chart-value">{hover === null ? '' : collateral(hover)}</span></h2></div><div className="segmented" aria-label="Rentang grafik">{['24H', '7D', '30D', 'ALL'].map(r => <button aria-pressed={range === r} className={range === r ? 'selected' : ''} key={r} onClick={() => { setHover(null); setRange(r); }}>{r}</button>)}</div></div><div ref={container} className="chart-viewport" style={{ display: actual.length ? undefined : 'none' }} role="img" aria-label="Grafik ekuitas aktual; geser dan zoom untuk menjelajah"/>{!actual.length && <div className="empty chart-empty"><span>Belum ada titik ekuitas</span><small>Grafik akan muncul setelah worker menyimpan valuasi aktual.</small></div>}<footer>Geser untuk menjelajah · scroll untuk zoom · valuasi pUSD tersimpan<br />Panah BUY / SELL = order tersimpan, bukan konfirmasi fill. Maksimal 100 order terbaru, dipetakan ke snapshot valuasi terdekat.{orders.error && <span className="error"> Marker order tidak tersedia: {orders.error.message}</span>}</footer></section>;
}
