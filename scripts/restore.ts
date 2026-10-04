import { createDecipheriv } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { backupKey, databaseManifest, pgCommand, pgEnvironment } from './backup.js';

async function cleanupStaging(temporary: string) {
  const root = resolve(tmpdir()), targetPath = resolve(temporary), childPath = relative(root, targetPath);
  if (!childPath || isAbsolute(childPath) || childPath === '..' || childPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || !childPath.startsWith('polymarket-restore-') || childPath.includes('/') || childPath.includes('\\')) throw new Error('Unsafe restore staging cleanup target');
  await rm(targetPath, { recursive: true, force: true });
}

async function restore() {
  const [source, confirmation] = process.argv.slice(2);
  const target = process.env.RESTORE_DATABASE_URL;
  if (!source || confirmation !== '--confirm-isolated-target' || !target) throw new Error('Explicit isolated restore target required');
  if (process.env.DATABASE_URL) {
    const production = pgEnvironment(process.env.DATABASE_URL), isolated = pgEnvironment(target);
    if (['PGHOST', 'PGPORT', 'PGDATABASE'].every(name => production[name] === isolated[name])) throw new Error('Restore target must differ from source database');
  }
  const key = backupKey(), sourcePath = resolve(source);
  const file = await open(sourcePath, 'r');
  let header: Buffer, prefix: Buffer, tag: Buffer, start: number, end: number;
  try {
    const size = (await file.stat()).size;
    prefix = Buffer.alloc(8); if ((await file.read(prefix, 0, 8, 0)).bytesRead !== 8 || prefix.toString('utf8', 0, 4) !== 'PMBK') throw new Error('Invalid backup');
    const length = prefix.readUInt32BE(4); if (length < 1 || length > 1_000_000 || size <= 8 + length + 16) throw new Error('Invalid backup size');
    header = Buffer.alloc(length); if ((await file.read(header, 0, length, 8)).bytesRead !== length) throw new Error('Invalid backup header');
    tag = Buffer.alloc(16); await file.read(tag, 0, 16, size - 16);
    start = 8 + length; end = size - 17;
  } finally { await file.close(); }
  const metadata = JSON.parse(header.toString('utf8')) as { version: number; nonce: string; counts: Record<string, string>; balanced: boolean };
  if (metadata.version !== 1 || !metadata.balanced || !metadata.counts || !/^[A-Za-z0-9+/]{16}$/.test(metadata.nonce)) throw new Error('Invalid backup metadata');
  const nonce = Buffer.from(metadata.nonce, 'base64'); if (nonce.length !== 12) throw new Error('Invalid nonce');
  const temporary = await mkdtemp(join(tmpdir(), 'polymarket-restore-')), dump = join(temporary, 'database.dump');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(Buffer.concat([prefix, header])); decipher.setAuthTag(tag);
    // Authenticate the complete archive before any database mutation.
    await pipeline(createReadStream(sourcePath, { start, end }), decipher, createWriteStream(dump, { flags: 'wx', mode: 0o600 }));
    const client = new pg.Client({ connectionString: target, connectionTimeoutMillis: 10_000, statement_timeout: 60_000 }); await client.connect();
    try {
      const existing = await client.query("SELECT count(*)::text AS count FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')");
      if (existing.rows[0].count !== '0') throw new Error('Restore requires an empty isolated database');
    } finally { await client.end(); }
    const child = spawn(pgCommand('pg_restore'), ['--dbname', pgEnvironment(target).PGDATABASE!, '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', dump], { env: pgEnvironment(target), timeout: 900_000, stdio: ['ignore', 'ignore', 'pipe'] }); child.stderr.resume();
    await new Promise<void>((done, fail) => { child.once('error', () => fail(new Error('Unable to start pg_restore'))); child.once('exit', code => code === 0 ? done() : fail(new Error('pg_restore failed'))); });
    const actual = await databaseManifest(target);
    if (JSON.stringify(actual.counts) !== JSON.stringify(metadata.counts)) throw new Error('Restored row counts differ from backup manifest');
    console.log('Restore completed into isolated database; table counts and journal balances verified.');
  } finally {
    await cleanupStaging(temporary);
  }
}
try { await restore(); } catch { console.error('Restore failed. Check isolated empty target, backup integrity, key, PostgreSQL client and ledger.'); process.exitCode = 1; }
