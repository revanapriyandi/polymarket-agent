import { bounded, classify, GatewayError } from './errors';

export interface ExchangeRequestState {
  rateLimitUntil: number;
  ordersBlockedUntil: number;
  postOnlyUntil: number;
  consecutiveRejections: number;
  reason: string;
  observedAt: string;
}
type RequestKind = 'read' | 'order' | 'cancel' | 'settlement' | 'heartbeat';

/** A shared, durable cooldown. A later job must obtain a new permit; signed writes are never replayed here. */
export class ExchangeRequestControl {
  private state: ExchangeRequestState;
  private persistence: Promise<void> = Promise.resolve();
  private readonly recorded = new WeakSet<GatewayError>();
  constructor(initial?: ExchangeRequestState | null, private readonly save?: (state: ExchangeRequestState) => Promise<void>) {
    this.state = { rateLimitUntil: 0, ordersBlockedUntil: 0, postOnlyUntil: 0, consecutiveRejections: 0, reason: '', observedAt: new Date().toISOString() };
    if (initial && [initial.rateLimitUntil, initial.ordersBlockedUntil, initial.postOnlyUntil, initial.consecutiveRejections].every(value => Number.isFinite(value) && value >= 0)) this.state = { ...initial };
  }
  snapshot(): ExchangeRequestState { return { ...this.state }; }
  private check(kind: RequestKind, postOnly: boolean) {
    const until = Math.max(this.state.rateLimitUntil, kind === 'order' ? this.state.ordersBlockedUntil : 0, kind === 'order' && !postOnly ? this.state.postOnlyUntil : 0);
    if (until > Date.now()) throw new GatewayError('EXCHANGE_BACKOFF', `Exchange cooldown: ${this.state.reason}; wait for fresh validation`, false, true, Math.ceil((until - Date.now()) / 1000));
  }
  async run<T>(kind: RequestKind, operation: () => Promise<T>, postOnly = false, timeoutMs = 20000): Promise<T> {
    this.check(kind, postOnly);
    try { return await bounded(operation(), kind !== 'read', timeoutMs); }
    catch (error) {
      const failure = classify(error, kind !== 'read');
      if (!this.recorded.has(failure) && ['RATE_LIMIT', 'MATCHING_ENGINE_RESTART', 'POST_ONLY_REJECTED', 'CANCEL_ONLY', 'TRADING_UNAVAILABLE'].includes(failure.code)) {
        this.recorded.add(failure);
        this.state.consecutiveRejections = Math.min(this.state.consecutiveRejections + 1, 6);
        const fallback = Math.min(30, 2 ** this.state.consecutiveRejections);
        const delay = Number.isFinite(failure.retryAfterSeconds) && failure.retryAfterSeconds! >= 0 ? failure.retryAfterSeconds! : fallback;
        const until = Date.now() + delay * 1000;
        if (failure.code === 'RATE_LIMIT') this.state.rateLimitUntil = Math.max(this.state.rateLimitUntil, until);
        else {
          this.state.ordersBlockedUntil = Math.max(this.state.ordersBlockedUntil, until);
          if (failure.code === 'MATCHING_ENGINE_RESTART' || failure.code === 'POST_ONLY_REJECTED') this.state.postOnlyUntil = Math.max(this.state.postOnlyUntil, until + (failure.code === 'MATCHING_ENGINE_RESTART' ? 120000 : 0));
        }
        this.state.reason = failure.code;
        this.state.observedAt = new Date().toISOString();
        const snapshot = this.snapshot();
        this.persistence = this.persistence.catch(() => undefined).then(() => this.save?.(snapshot));
        await this.persistence;
      }
      throw failure;
    }
  }
}
