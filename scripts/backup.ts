import { createCipheriv, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, link, rm, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function backupKey(): Buffer {
  const value = process.env.BACKUP_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('BACKUP_KEY must encode 32 bytes');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_KEY must encode 32 bytes');
  return key;
}
export function pgEnvironment(connection: string): NodeJS.ProcessEnv {
  const url = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL URL required');
  const ssl = url.searchParams.get('sslmode');
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), ...(ssl ? { PGSSLMODE: ssl } : {}) };
}
export function pgCommand(name: 'pg_dump' | 'pg_restore'): string { return process.env.PG_BIN ? join(process.env.PG_BIN, process.platform === 'win32' ? `${name}.exe` : name) : name; }
export async function databaseManifest(connection: string, snapshotClient?: pg.Client) {
  const client = snapshotClient ?? new pg.Client({ connectionString: connection, connectionTimeoutMillis: 10_000, statement_timeout: 60_000 });
  if (!snapshotClient) await client.connect();
  try {
    const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const counts: Record<string, string> = {};
    for (const { tablename } of tables.rows) {
      const identifier = '"' + tablename.replaceAll('"', '""') + '"';
      counts[tablename] = String((await client.query(`SELECT count(*)::text AS count FROM public.${identifier}`)).rows[0].count);
    }
    const balance = await client.query("SELECT count(*)::text AS count FROM (SELECT j.id FROM journals j LEFT JOIN ledger_entries e ON e.journal_id=j.id GROUP BY j.id HAVING count(e.id)<2 OR coalesce(sum(e.amount),0)<>0) invalid");
    if (balance.rows[0].count !== '0') throw new Error('Ledger contains unbalanced journals');
    return { counts, balanced: true as const };
  } finally { if (!snapshotClient) await client.end(); }
}
export async function createBackup(connection: string, destination: string): Promise<void> {
  const key = backupKey();
  const output = resolve(destination), partial = `${output}.${randomBytes(8).toString('hex')}.partial`;
  await mkdir(dirname(output), { recursive: true });
  const snapshotClient = new pg.Client({ connectionString: connection, connectionTimeoutMillis: 10_000, statement_timeout: 60_000 });
  await snapshotClient.connect();
  try {
    await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = String((await snapshotClient.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot);
    const manifest = await databaseManifest(connection, snapshotClient);
    const nonce = randomBytes(12);
    const header = Buffer.from(JSON.stringify({ version: 1, nonce: nonce.toString('base64'), createdAt: new Date().toISOString(), ...manifest }));
    if (header.length > 1_000_000) throw new Error('Backup metadata too large');
    const prefix = Buffer.alloc(8); prefix.write('PMBK'); prefix.writeUInt32BE(header.length, 4);
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.concat([prefix, header]));
    const child = spawn(pgCommand('pg_dump'), ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snapshot}`], { env: pgEnvironment(connection), timeout: 900_000, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume();
    const completion = new Promise<void>((resolveDone, reject) => { child.once('error', () => reject(new Error('Unable to start pg_dump'))); child.once('exit', code => code === 0 ? resolveDone() : reject(new Error('pg_dump failed'))); });
    const stream = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    try {
      stream.write(prefix); stream.write(header);
      await Promise.all([pipeline(child.stdout, cipher, stream, { end: false }), completion]);
      stream.end(cipher.getAuthTag());
      await new Promise<void>((done, fail) => { stream.once('finish', done); stream.once('error', fail); });
      await snapshotClient.query('COMMIT');
      const file = await open(partial, 'r+'); try { await file.sync(); } finally { await file.close(); }
      await link(partial, output); await rm(partial); await chmod(output, 0o600);
    } catch (error) { child.kill(); stream.destroy(); await rm(partial, { force: true }); throw error; }
  } finally { await snapshotClient.query('ROLLBACK').catch(() => undefined); await snapshotClient.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.env.DATABASE_URL || !process.argv[2]) throw new Error('Usage: backup.ts DESTINATION; DATABASE_URL and BACKUP_KEY required');
    await createBackup(process.env.DATABASE_URL, process.argv[2]); console.log('Encrypted database backup completed.');
  } catch { console.error('Backup failed. Verify key, PostgreSQL client, ledger and snapshot permissions.'); process.exitCode = 1; }
}
