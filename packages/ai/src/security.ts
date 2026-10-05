import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

function key(value = process.env.MASTER_KEY): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('MASTER_KEY must encode 32 bytes');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32) throw new Error('MASTER_KEY must encode 32 bytes');
  return bytes;
}
export function encryptSecret(value: string, masterKey?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(masterKey), iv);
  cipher.setAAD(Buffer.from('polymarket-provider-secret:v1'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), ciphertext.toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
}
export function decryptSecret(value: string, masterKey?: string): string {
  const [version, nonce, ciphertext, tag, extra] = value.split('.');
  if (version !== 'v1' || !nonce || ciphertext === undefined || !tag || extra) throw new Error('Invalid encrypted secret');
  const iv = Buffer.from(nonce, 'base64'), auth = Buffer.from(tag, 'base64');
  if (iv.length !== 12 || auth.length !== 16) throw new Error('Invalid encrypted secret');
  const cipher = createDecipheriv('aes-256-gcm', key(masterKey), iv);
  cipher.setAAD(Buffer.from('polymarket-provider-secret:v1'));
  cipher.setAuthTag(auth);
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64')), cipher.final()]).toString('utf8');
}
export function sanitizeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 0;
  return status >= 400 && status <= 599 ? `Provider request failed (HTTP ${status})` : `Provider operation failed (${/^[A-Za-z]{1,40}$/.test(name) ? name : 'Error'})`;
}
export function redactSecrets<T>(value: T): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /secret|token|authorization|password|api.?key|headers/i.test(k) ? '[REDACTED]' : redactSecrets(v)]));
  return value;
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) || (a === 100 && b! >= 64 && b! <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  // Only global unicast IPv6; reject mapped IPv4, link-local, ULA, loopback and documentation.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0|2|10|20):/i.test(address) && !/^2002:/i.test(address);
}
export function endpointPolicy(endpoint: string): { url: URL; localAllowed: boolean } {
  const url = new URL(endpoint);
  const allowlist = (process.env.AI_ENDPOINT_ALLOWLIST ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const localAllowed = allowlist.includes(url.origin);
  if (url.username || url.password || url.hash || url.search || (!localAllowed && url.protocol !== 'https:') || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid provider endpoint');
  return { url, localAllowed };
}
/** Buffered, non-streaming transport pins a validated DNS answer into the socket lookup. */
export function guardedFetch(endpoint: string, timeoutMs: number): typeof fetch {
  const policy = endpointPolicy(endpoint);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== policy.url.origin || url.username || url.password || url.hash) throw new Error('Provider request origin rejected');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      const abort = () => reject(new Error('Provider DNS timeout'));
      signal.addEventListener('abort', abort, { once: true });
      lookup(host, { all: true, verbatim: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    if (addresses.some(v => /^(169\.254\.|100\.100\.100\.200$|fd00:ec2:)/i.test(v.address))) throw new Error('Metadata address rejected');
    if (!addresses.length || (!policy.localAllowed && addresses.some(v => !publicAddress(v.address)))) throw new Error('Provider address rejected');
    const chosen = addresses[0]!;
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    const body = init?.body;
    if (input instanceof Request && !init?.body && input.body) throw new Error('Request bodies require explicit init.body');
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new Error('Unsupported provider request body');
    return await new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: init?.method ?? 'GET', headers, signal, family: chosen.family,
        lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
      }, response => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) { response.destroy(); reject(new Error('Provider redirect rejected')); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) request.destroy(new Error('Provider response too large')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) if (value) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response([204, 205, 304].includes(response.statusCode ?? 200) ? null : Buffer.concat(chunks), { status: response.statusCode, headers: responseHeaders }));
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('Provider timeout')), timeoutMs);
      request.on('close', () => clearTimeout(timer)); request.on('error', reject);
      if (body != null) request.write(body); request.end();
    });
  };
}
