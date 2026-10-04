import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { publicAddress } from '../../ai/src/security.js';
export async function publicSourceUrl(value: string): Promise<string | null> {
  try { const url = new URL(value); if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') return null; const host = url.hostname.replace(/^\[|\]$/g, ''); const addresses = await Promise.race([isIP(host) ? Promise.resolve([{ address: host }]) : lookup(host, { all: true }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('DNS timeout')), 5000); timer.unref(); })]); return addresses.length && addresses.every(row => publicAddress(row.address)) ? url.toString() : null; } catch { return null; }
}
/** Separate public-source transport never inherits local AI endpoint exceptions. */
export async function fetchPublicSource(value: string): Promise<string> {
  const safe = await publicSourceUrl(value); if (!safe) throw new Error('Public source URL rejected');
  const url = new URL(safe), host = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.timeout(10000);
  const addresses = await Promise.race([isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true }), new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(new Error('DNS timeout')), { once: true }); })]);
  if (!addresses.length || addresses.some(row => !publicAddress(row.address))) throw new Error('Public source address rejected');
  const chosen = addresses[0]!;
  return new Promise((resolve, reject) => { const req = request(url, { signal, family: chosen.family, headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'accept-encoding': 'identity', 'user-agent': 'PolymarketResearch/1.0' }, lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family) }, res => { if (res.statusCode !== 200) { res.destroy(); reject(new Error('Source returned unsuccessful HTTP status')); return; } const chunks: Buffer[] = []; let size = 0; res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) req.destroy(new Error('Source exceeds size limit')); else chunks.push(chunk); }); res.on('error', reject); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); }); req.on('error', reject); req.end(); });
}
