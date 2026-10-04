import { randomBytes, createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { auth } from '../../../packages/core/src/auth.js';
import { env } from '../../../packages/core/src/config.js';
import { redis } from '../../../packages/core/src/queue.js';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function requestHeaders(req: FastifyRequest) { const headers = new Headers(); for (const [key,value] of Object.entries(req.headers)) if(value!==undefined) headers.set(key,Array.isArray(value)?value.join(', '):value); return headers; }
export async function owner(req: FastifyRequest) {
  const session = await auth.api.getSession({ headers: requestHeaders(req) });
  if (!session || session.user.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) throw new HttpError(401, 'Masuk sebagai pemilik untuk melanjutkan');
  return session;
}
export async function stepUp(req: FastifyRequest) {
  const session = await owner(req), token = req.headers['x-step-up-token'];
  if (typeof token !== 'string') throw new HttpError(403, 'Konfirmasi password diperlukan');
  const bound = await redis.get(`stepup:${createHash('sha256').update(token).digest('hex')}`);
  if (bound !== session.session.id) throw new HttpError(403, 'Konfirmasi password kadaluwarsa');
}
export async function reauthenticate(req: FastifyRequest, password: string) {
  const session = await owner(req);
  try { const result = await auth.api.verifyPassword({ headers: requestHeaders(req), body: { password } }); if(result.status!==true) throw new HttpError(403,'Password tidak sesuai'); }
  catch { throw new HttpError(403, 'Password tidak sesuai'); }
  const token = randomBytes(32).toString('hex');
  await redis.set(`stepup:${createHash('sha256').update(token).digest('hex')}`, session.session.id, 'EX', 300);
  return { token, expiresAt: new Date(Date.now() + 300000).toISOString() };
}
