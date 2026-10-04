import type { ReactNode } from 'react';
import type { TableName } from '../../../packages/shared/src/index';
import { collateral, date, money, percent } from './api';

type Row = Record<string, unknown>;
export interface TableColumn { key: string; title: string; value: (row: Row) => unknown; render?: (value: unknown, row: Row) => ReactNode; className?: string }
export const tableNames: Record<TableName, string> = { positions: 'posisi', orders: 'order', opportunities: 'peluang', decisions: 'keputusan trading', history: 'transaksi', invocations: 'pemakaian AI', tools: 'pemanggilan tool', forecasts: 'forecast AI' };
export function display(value: unknown): string { return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
const field = (key: string) => (row: Row): unknown => key.split('.').reduce<unknown>((item, part) => item && typeof item === 'object' ? (item as Row)[part] : undefined, row);
const numeric = (value: unknown) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const quantity = (value: unknown) => numeric(value) == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(Number(value));
const price = (value: unknown) => numeric(value) == null ? '—' : Number(value).toFixed(4);
const amount = (value: unknown) => collateral(numeric(value));
const probability = (value: unknown) => percent(numeric(value));
const pnl = (value: unknown) => <span className={numeric(value) == null ? 'muted' : Number(value) > 0 ? 'positive' : Number(value) < 0 ? 'negative' : ''}>{amount(value)}</span>;
const badge = (value: unknown) => <span className={`badge ${String(value ?? '').replace(/[^a-zA-Z-]/g, '')}`}>{display(value)}</span>;
const column = (key: string, title: string, render?: TableColumn['render'], className?: string): TableColumn => ({ key, title, value: field(key), render, className });
const market: TableColumn = { key: 'question', title: 'Market', className: 'market-cell', value: row => row.question ?? row.marketId ?? (row.intent as Row | undefined)?.marketId, render: (value, row) => <div><strong>{display(value)}</strong>{(row.outcome === 'YES' || row.outcome === 'NO') && <span className={`outcome ${row.outcome === 'YES' ? 'yes' : 'no'}`}>{row.outcome}</span>}</div> };
const strategy = column('strategy', 'Strategi', value => value === 'prediction' ? 'Prediksi AI' : value === 'arbitrage' ? 'Arbitrase' : value === 'exit' ? 'Exit' : display(value));
const status = column('status', 'Status', badge);
const created = column('createdAt', 'Waktu', date);

export const tableColumns: Record<TableName, TableColumn[]> = {
  positions: [market, strategy, column('shares', 'Saham', quantity), column('averagePrice', 'Harga rata-rata', price), column('mark', 'Harga mark', (value, row) => row.markFresh ? price(value) : <span className="muted" title="Harga belum tersedia atau lebih lama dari 120 detik">Belum dinilai</span>), column('positionValue', 'Nilai posisi', amount), column('unrealizedPnl', 'P&L belum realisasi', pnl), status],
  orders: [market, column('intent.side', 'Sisi', badge), column('intent.limitPrice', 'Harga limit', price), column('intent.shares', 'Saham', quantity), column('filledShares', 'Terisi', quantity), column('intent.orderType', 'Jenis'), status, created],
  opportunities: [market, strategy, column('payload.netProfit', 'Estimasi net arbitrase', pnl), column('payload.edge', 'Edge setelah biaya', probability), { ...status, render: (value, row) => badge(value === 'candidate' && Date.parse(String(row.expiresAt)) < Date.now() ? 'expired' : value) }, column('expiresAt', 'Berlaku hingga', date)],
  decisions: [market, column('intent.side', 'Sisi', badge), column('intent.limitPrice', 'Harga limit', price), column('intent.shares', 'Saham', quantity), column('approved', 'Keputusan', value => badge(value === true ? 'approved' : 'rejected')), column('reason', 'Alasan', undefined, 'reason-cell'), created],
  history: [created, column('kind', 'Jenis transaksi'), column('description', 'Keterangan', undefined, 'reason-cell')],
  forecasts: [market, column('payload.probability', 'Probabilitas YES', probability), column('payload.lower', 'Batas bawah', probability), column('payload.upper', 'Batas atas', probability), column('payload.abstain', 'Sinyal', value => badge(value === true ? 'abstain' : 'forecast')), column('outcome', 'Hasil aktual', value => value == null ? 'Belum selesai' : probability(value)), created],
  invocations: [created, column('model', 'Model'), column('role', 'Peran'), column('cost', 'Biaya (USD)', value => money(numeric(value))), column('costStatus', 'Status biaya'), column('latencyMs', 'Durasi', value => numeric(value) == null ? '—' : `${(Number(value) / 1000).toFixed(1)} dtk`), status],
  tools: [created, column('role', 'Agent'), column('tool', 'Tool'), column('skill', 'Skill'), column('durationMs', 'Durasi', value => `${quantity(value)} ms`), column('result.ok', 'Hasil', value => badge(value === true ? 'complete' : 'failed'))],
};
