import { eq } from 'drizzle-orm';
import { db, schema, transaction } from '../../db/src/index.js';
import { defaultSettings, roles, agentNames, type Settings, type AgentRole, type AgentView } from '../../shared/src/index.js';
export async function initialize() {
  await db.insert(schema.settings).values({ id: 1, payload: defaultSettings }).onConflictDoNothing();
  await db.insert(schema.controls).values({ id: 1 }).onConflictDoNothing();
  for (const role of roles) await db.insert(schema.agents).values({ role, payload: { role, name: agentNames[role], status: 'waiting', skill: role, lastTool: null, reason: 'Menunggu heartbeat worker', heartbeatAt: null, lastRunAt: null, durationMs: null, runs: 0 } }).onConflictDoNothing();
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73010)');
    const inserted = await client.query("INSERT INTO journals(id,mode,kind,description) VALUES('paper-initial-capital','paper','deposit','Modal virtual awal') ON CONFLICT DO NOTHING RETURNING id");
    if (inserted.rowCount) await client.query("INSERT INTO ledger_entries(journal_id,mode,account,amount) VALUES ('paper-initial-capital','paper','cash',1000),('paper-initial-capital','paper','capital',-1000)");
  });
}
export async function readSettings(): Promise<{ settings: Settings; version: number }> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  if (!row) throw new Error('Database belum diinisialisasi');
  return { settings: row.payload, version: row.version };
}
export async function readControl() { const [row] = await db.select().from(schema.controls).where(eq(schema.controls.id, 1)); if (!row) throw new Error('Control state missing'); return row; }
export async function writeState(key: string, value: unknown) { await db.insert(schema.systemState).values({ key, value }).onConflictDoUpdate({ target: schema.systemState.key, set: { value, updatedAt: new Date() } }); }
export async function readState<T>(key: string): Promise<T | null> { const [r] = await db.select().from(schema.systemState).where(eq(schema.systemState.key, key)); return r ? r.value as T : null; }
export async function audit(role: string, title: string, detail: string, level: 'info' | 'warning' | 'error' = 'info', operationId?: string) { await db.insert(schema.audit).values({ role, title, detail: detail.slice(0, 4000), level, operationId }); }
export async function agentState(role: AgentRole, update: Partial<AgentView>) {
  const [r] = await db.select().from(schema.agents).where(eq(schema.agents.role, role));
  if (!r) return;
  await db.update(schema.agents).set({ payload: { ...r.payload, ...update, heartbeatAt: new Date().toISOString() }, updatedAt: new Date() }).where(eq(schema.agents.role, role));
}
