import pg from 'pg';

// Uses a dedicated short-lived connection so it remains independent of worker state.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000, statement_timeout: 2000 });
try {
  if (!process.env.DATABASE_URL) throw new Error('Missing database configuration');
  await client.connect();
  const result = await client.query<{ key: string; value: { at?: string; ok?: boolean; pid?: number } }>(
    'SELECT key,value FROM system_state WHERE key=ANY($1::text[])',
    [['worker-heartbeat', 'queue-health:polymarket-operations']],
  );
  const state = Object.fromEntries(result.rows.map(row => [row.key, row.value]));
  const recent = (at: string | undefined, maximumAge: number) => {
    const timestamp = at ? Date.parse(at) : NaN, age = Date.now() - timestamp;
    return Number.isFinite(timestamp) && age >= -1000 && age <= maximumAge;
  };
  const pulse = state['queue-health:polymarket-operations'];
  if (!recent(state['worker-heartbeat']?.at, 20_000) || pulse?.ok !== true || !recent(pulse.at, 45_000) || !pulse.pid || pulse.pid!==state['worker-heartbeat']?.pid) {
    throw new Error('Worker or operations queue is stale');
  }
  console.log('Worker heartbeat and operations queue are healthy.');
} catch {
  console.error('Worker health check failed.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
