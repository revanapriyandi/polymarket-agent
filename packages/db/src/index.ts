import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../../core/src/config.js';
import * as schema from './schema.js';
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 20000 });
export const db = drizzle(pool, { schema });
export { schema };
export type Transaction = pg.PoolClient;
export async function transaction<T>(fn: (client: Transaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
