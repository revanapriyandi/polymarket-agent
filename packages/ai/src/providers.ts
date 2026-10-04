import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenResponses } from '@ai-sdk/open-responses';
import type { LanguageModel } from 'ai';
import { ProviderConfigSchema, ProviderSecretsSchema, type ProviderConfig, type ProviderSecrets } from '../../shared/src/index.js';
import { endpointPolicy, guardedFetch } from './security.js';

const officialEndpoints = { 'openai-responses': 'https://api.openai.com/v1', 'openai-chat': 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta' };
const forbiddenHeaders = /^(host|connection|content-length|transfer-encoding|upgrade|cookie|set-cookie|proxy-.*|forwarded|x-forwarded-.*|authorization|x-api-key|x-goog-api-key|anthropic-version)$/i;
export function resolveProvider(config: ProviderConfig, secrets: ProviderSecrets) {
  const parsed = ProviderConfigSchema.parse(config), secure = ProviderSecretsSchema.parse(secrets);
  if (/[\r\n]/.test(secure.apiKey ?? '')) throw new Error('Invalid provider key');
  const official = officialEndpoints[parsed.protocol as keyof typeof officialEndpoints];
  if (official && parsed.endpoint && parsed.endpoint.replace(/\/$/, '') !== official) throw new Error('Official provider endpoint cannot be overridden');
  const endpoint = official ?? parsed.endpoint;
  if (!endpoint) throw new Error('Custom provider endpoint required');
  const policy = endpointPolicy(endpoint);
  if (!secure.apiKey?.trim() && (official || (!policy.localAllowed && !Object.keys(secure.headers).length))) throw new Error('Provider key not configured');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(secure.headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || forbiddenHeaders.test(name) || /[\r\n]/.test(value)) throw new Error('Custom header rejected');
    headers[name] = value;
  }
  if (secure.authHeader) {
    if (official || !/^[A-Za-z0-9-]+$/.test(secure.authHeader) || forbiddenHeaders.test(secure.authHeader)) throw new Error('Custom authentication header rejected');
    if (!secure.apiKey?.trim()) throw new Error('Custom authentication key not configured');
    headers[secure.authHeader] = secure.apiKey;
  }
  return { config: parsed, secrets: secure, endpoint, headers, fetch: guardedFetch(endpoint, parsed.timeoutMs) };
}
/** Internal only: callers use run/probe functions through their persisted budget guard. */
export function buildModel(config: ProviderConfig, secrets: ProviderSecrets): LanguageModel {
  const p = resolveProvider(config, secrets);
  const options = { apiKey: p.secrets.apiKey || 'local-no-auth', headers: p.headers, fetch: p.fetch };
  if (!p.secrets.apiKey || p.secrets.authHeader) {
    const transport = options.fetch;
    options.fetch = (input, init) => { const headers = new Headers(init?.headers); headers.delete('authorization'); headers.delete('x-api-key'); return transport(input, { ...init, headers }); };
  }
  switch (p.config.protocol) {
    case 'openai-responses': return createOpenAI({ ...options, baseURL: p.endpoint }).responses(config.model);
    case 'openai-chat': return createOpenAI({ ...options, baseURL: p.endpoint }).chat(config.model);
    case 'anthropic': case 'custom-anthropic': return createAnthropic({ ...options, baseURL: p.endpoint })(config.model);
    case 'google': return createGoogleGenerativeAI({ ...options, baseURL: p.endpoint })(config.model);
    case 'custom-chat': return createOpenAICompatible({ ...options, name: 'custom-chat', baseURL: p.endpoint, supportsStructuredOutputs: true, includeUsage: true })(config.model);
    case 'custom-responses': return createOpenResponses({ ...options, name: 'custom-responses', url: p.endpoint })(config.model);
  }
}
export async function discoverModels(config: ProviderConfig, secrets: ProviderSecrets): Promise<string[]> {
  const p = resolveProvider(config, secrets);
  const base = config.protocol === 'custom-responses' ? p.endpoint.replace(/\/responses\/?$/, '') : p.endpoint.replace(/\/$/, '');
  if (config.protocol === 'custom-responses' && base === p.endpoint) throw new Error('Model discovery requires a Responses endpoint ending in /responses');
  const headers = { ...p.headers };
  if (config.protocol === 'anthropic' || config.protocol === 'custom-anthropic') { if (p.secrets.apiKey && !p.secrets.authHeader) headers['x-api-key'] = p.secrets.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (config.protocol === 'google') headers['x-goog-api-key'] = p.secrets.apiKey!;
  else if (p.secrets.apiKey && !p.secrets.authHeader) headers.authorization = `Bearer ${p.secrets.apiKey}`;
  const ids: string[] = []; let next: string | undefined;
  const signal = AbortSignal.timeout(config.timeoutMs);
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${base}/models`);
    if (next) url.searchParams.set(config.protocol === 'google' ? 'pageToken' : 'after_id', next);
    const response = await p.fetch(url, { headers, signal });
    if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
    const data = await response.json() as { data?: { id?: string }[]; models?: { name?: string }[]; nextPageToken?: string; has_more?: boolean; last_id?: string };
    const rows = config.protocol === 'google' ? data.models?.map(v => v.name?.replace(/^models\//, '')) : data.data?.map(v => v.id);
    if (!Array.isArray(rows)) throw new Error('Invalid model discovery response');
    ids.push(...rows.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200));
    next = config.protocol === 'google' ? data.nextPageToken : data.has_more ? data.last_id : undefined;
    if (!next) break;
  }
  return [...new Set(ids)].sort();
}
