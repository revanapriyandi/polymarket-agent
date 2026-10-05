# Trading platform expansion

Approved direction: separate trading pages, deeper analytics/research/agent visibility, a dedicated server wallet for 24/7 operation, and market updates that do not depend on the dashboard snapshot timer.

## Realtime and market terminal

The existing market WebSocket only updates connection health; strategy proposals are scheduled by periodic discovery. Replace this gap with validated quote events, bounded Redis pub/sub delivery and coalesced event-triggered strategy checks. The server must distinguish exchange timestamp, worker receive time, decision queue delay and browser delivery age. Fresh REST books and existing deterministic permits remain mandatory before execution. A disconnected or stale feed must block new entries; position risk management continues. Avoid claiming a latency guarantee before measurement.

Expose a market terminal with market search, YES/NO probability history, real observed OHLC where supported by source data, overlays, comparison, order-book depth, spread, liquidity, resolution information and freshness. Historical point prices cannot be presented as exchange trade candles or fabricated volume. Use the existing Lightweight Charts and official SDK.

## Analytics

Use mode-scoped ledger/equity/order/position data for P&L, fee attribution, daily performance, strategy comparison, exposure, drawdown, closed market outcomes, execution quality and probability calibration. Label the basis and period of each metric. Group paired arbitrage positions by market and strategy instead of counting every fill as a winning trade. Display unavailable statistics as unavailable rather than zero. Keep deposits out of profit; strategy attribution must explain unallocated operating costs.

## Research and agents

Build a per-market research workspace with resolution rules, source provenance/dates, evidence text, supporting/opposing forecast references, probability history, review stages and actionable prerequisites. Reuse the existing durable research pipeline and budget rules for manual requests. Add agent detail views with skill/version/allowlist, recent runs, success/failure duration, queue state and specific actions. Manual jobs require owner authorization, valid inputs and idempotent bounded queues.

## Wallet onboarding

The user selected a dedicated server wallet. Generate and encrypt signer material server-side; never put private keys in model tools, public responses or logs. A short setup flow supplies required official builder/relayer configuration, creates/connects the account via the installed official SDK, derives trading credentials and reports each readiness condition as a human-readable step. Required external credentials cannot be replaced by a pretend connect button. Keep the existing environment-based wallet compatible. Lifecycle mutations must be durable/idempotent; uncertain external outcomes are reconciled before retry. Live activation remains a separate action gated by evaluation, explicit risk configuration, reconciliation and server enablement.

## Delivery and verification

Keep modules focused and avoid unrequested changes to authentication or unrelated services. Run typecheck, lint, production build and manual browser/API verification; no automated suite unless requested. Verify real feed behavior and measured timing separately from paper fills, funded-wallet operations, provider research and live trading. Push/deploy the verified release to the existing public repository and VPS, with an encrypted backup before replacement.

Official references checked on 2026-10-04: https://docs.polymarket.com/trading/wallets-auth, https://docs.polymarket.com/trading/overview, https://docs.polymarket.com/trading/session-keys. Session keys are beta and require an enabled builder account; they are not assumed to be available for this installation.
