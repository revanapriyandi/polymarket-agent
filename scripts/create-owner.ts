import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { env } from '../packages/core/src/config.js';
import { pool, transaction } from '../packages/db/src/index.js';
const rl = createInterface({ input: stdin, output: stdout });
try {
  const password = process.env.OWNER_INITIAL_PASSWORD ?? await rl.question('Password pemilik (min. 12 karakter; input terminal terlihat): ');
  if (password.length < 12 || password.length > 128) throw new Error('Password must contain 12–128 characters');
  const hash = await hashPassword(password);
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73000)');
    if ((await client.query('SELECT id FROM auth_user LIMIT 1')).rowCount) throw new Error('Owner already exists; refusing to replace credentials');
    const id = randomUUID();
    await client.query('INSERT INTO auth_user(id,name,email,email_verified) VALUES($1,$2,$3,true)', [id, 'Owner', env.OWNER_EMAIL.toLowerCase()]);
    await client.query("INSERT INTO auth_account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)", [randomUUID(), id, hash]);
  });
  console.log('Owner created. Public signup remains disabled.');
} finally { rl.close(); await pool.end(); }
