import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db, schema } from '../../db/src/index.js';
import { env } from './config.js';
export const auth = betterAuth({
  appName: 'Polymarket Agent', baseURL: env.APP_ORIGIN, basePath: '/api/auth', secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: 'pg', schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification } }),
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
  trustedOrigins: [env.APP_ORIGIN], session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 30, cookieCache: { enabled: false } },
  advanced: { useSecureCookies: env.APP_ORIGIN.startsWith('https:'), disableCSRFCheck: false },
  rateLimit: { enabled: true, window: 60, max: 30 },
  databaseHooks: { user: { create: { before: async data => { if (data.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) throw new Error('Owner only'); return { data }; } } } },
});
