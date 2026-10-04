import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../packages/db/src/index.js';
import { initialize } from '../packages/core/src/state.js';
try { await migrate(db, { migrationsFolder: './packages/db/migrations' }); await initialize(); console.log('Database migration and initial state complete.'); }
finally { await pool.end(); }
