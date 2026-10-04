import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../../packages/db/src/index.js';
import { readControl } from '../../../packages/core/src/state.js';
import { HttpError } from './security.js';
const tables = { positions: { table: 'positions', date: 'opened_at', mode: true }, orders: { table: 'orders', date: 'created_at', mode: true }, opportunities: { table: 'opportunities', date: 'created_at', mode: false }, decisions: { table: 'decisions', date: 'created_at', mode: true }, history: { table: 'journals', date: 'created_at', mode: true }, forecasts: { table: 'forecasts', date: 'created_at', mode: false }, invocations: { table: 'invocations', date: 'created_at', mode: true }, tools: { table: 'tool_runs', date: 'created_at', mode: false } } as const;
const nameSchema = z.enum(['positions','orders','opportunities','decisions','history','forecasts','invocations','tools']);
function redact(value:unknown):unknown { if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>! /^(signed_?payload|secrets?|ciphertext|password|api_?key|private_?key|authorization|cookie|headers|access_?token|session_?token)$/i.test(key)).map(([key,item])=>[key,redact(item)]));return value; }
function clean(row: Record<string, unknown>) { return Object.fromEntries(Object.entries(row).map(([k,v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), redact(v)]).filter(([k])=>! /^(signedPayload|secrets?|ciphertext|password|apiKey|privateKey|authorization|cookie|headers|accessToken|sessionToken)$/i.test(String(k)))); }
function csvCell(v: unknown) { let s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''); if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }
export async function registerTables(app: FastifyInstance) {
  async function query(name: unknown, rawQuery: unknown, exportAll = false) {
    const meta = tables[nameSchema.parse(name)], q = z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), search: z.string().max(200).default(''), status: z.string().max(50).default('') }).parse(rawQuery);
    const { mode } = await readControl(), values: unknown[] = [];
    const where = ['true'];
    if (meta.mode) { values.push(mode); where.push(`t.mode=$${values.length}`); }
    if (meta.table==='opportunities') { values.push(mode); where.push(`t.payload->>'mode'=$${values.length}`); }
    if (q.search) { values.push(`%${q.search.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')}%`); where.push(`(to_jsonb(t)-'signed_payload')::text ILIKE $${values.length}`); }
    if (q.status) { values.push(q.status); where.push(`to_jsonb(t)->>'status'=$${values.length}`); }
    const condition = where.join(' AND '), count = await pool.query(`SELECT count(*)::int n FROM ${meta.table} t WHERE ${condition}`, values);
    values.push(exportAll ? 10000 : q.pageSize, exportAll ? 0 : (q.page-1)*q.pageSize);
    const rows = await pool.query(`SELECT to_jsonb(t)-'signed_payload' payload FROM ${meta.table} t WHERE ${condition} ORDER BY ${meta.date} DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return { rows: rows.rows.map(r => clean(r.payload)), total: count.rows[0].n, page: q.page, pageSize: exportAll ? 10000 : q.pageSize };
  }
  app.get('/api/table/:name', async req => query((req.params as { name: string }).name, req.query));
  app.get('/api/table/:name/export', async (req, reply) => {
    const name = (req.params as { name: string }).name, data = await query(name, req.query, true);
    const keys = Object.keys(data.rows[0] ?? { id: null });
    const csv = [keys.map(csvCell).join(','), ...data.rows.map(row => keys.map(k => csvCell(row[k])).join(','))].join('\r\n');
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.csv"`).send('\uFEFF' + csv);
  });
  app.get('/api/detail/:name/:id', async req => {
    const p = z.object({ name: nameSchema, id: z.string().min(1).max(200) }).parse(req.params), table = tables[p.name];
    const row = (await pool.query(`SELECT to_jsonb(t)-'signed_payload' payload FROM ${table.table} t WHERE id::text=$1`, [p.id])).rows[0];
    if (!row) throw new HttpError(404, 'Record tidak ditemukan'); return clean(row.payload);
  });
}
