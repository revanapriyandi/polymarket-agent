export class GatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly ambiguous = false, public readonly retryable = false, public readonly retryAfterSeconds?: number) { super(message); this.name = 'GatewayError'; }
}
export function classify(error: unknown, mutation = false): GatewayError {
  if (error instanceof GatewayError) return error;
  const value = error as { name?: string; status?: number; statusCode?: number; message?: string; code?: string; restriction?: string; retryAfter?: number };
  const status = value.status ?? value.statusCode;
  const text = `${value.code ?? ''} ${value.message ?? ''} ${value.restriction ?? ''}`.toLowerCase();
  const code = status === 425 || value.restriction === 'restarting' ? 'MATCHING_ENGINE_RESTART' : /post.only/.test(text) ? 'POST_ONLY_REJECTED' : /cancel.only|closed.only/.test(text) ? 'CANCEL_ONLY' : status === 429 || value.name === 'RateLimitError' ? 'RATE_LIMIT' : status === 503 ? 'TRADING_UNAVAILABLE' : /balance|allowance/.test(text) ? 'INSUFFICIENT_BALANCE_ALLOWANCE' : /geoblock|restricted/.test(text) ? 'GEO_BLOCKED' : /timeout|transport|network|connection/i.test(`${value.name} ${text}`) ? 'TRANSPORT_UNKNOWN' : 'EXCHANGE_ERROR';
  const explicitRejection = value.name === 'RateLimitError' || (value.name === 'RequestRejectedError'
    && (status === 425 || status === 429 || (status !== undefined && status >= 400 && status < 500 && ![408, 425].includes(status)) || value.restriction === 'post_only' || value.restriction === 'restarting'));
  return new GatewayError(code, value.message ?? 'Polymarket request failed', mutation && !explicitRejection, !mutation && (code === 'RATE_LIMIT' || code === 'TRANSPORT_UNKNOWN'), value.retryAfter);
}
export async function bounded<T>(operation: Promise<T>, mutation = false, timeoutMs = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GatewayError('TIMEOUT', 'Request timed out; reconcile before another write', mutation, !mutation)), timeoutMs); })]); }
  catch (error) { throw classify(error, mutation); }
  finally { clearTimeout(timer); }
}
