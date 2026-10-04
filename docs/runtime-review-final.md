# Runtime review follow-up — 2026-10-04

This review inspected execution, portfolio, gateway and forecast permission boundaries. Findings are source-derived. No wallet transaction, paid provider request or automated test suite was executed during this follow-up.

## Resolved concrete findings

1. **P1 — Unknown external resting orders could pass live reconciliation.** The previous reconciliation iterated persisted orders and used exchange open orders only as a lookup. An external resting order with no local reservation could coexist with matching cash/positions and leave reconciliation healthy. `apps/worker/src/portfolio.ts` now compares every external open order ID against local nonterminal live orders before reporting a clean reconciliation. An untracked order blocks entry; it is not adopted or cancelled automatically.

2. **P2 — A known pre-dispatch settlement failure permanently consumed its deterministic operation ID.** `ON CONFLICT DO NOTHING` prevented another attempt after transient readiness/database-preflight failure. New settlement records carry a stable operation fingerprint and attempt number. A retry requires an explicit `failedBeforeDispatch: true` marker, valid attempt metadata, failed status and elapsed backoff. At most three attempts are permitted, with 30 seconds before the second and 60 seconds before the third. Each retry has its own durable ID and audit. The dispatch flag is set before calling the SDK: a failure after dispatch remains ambiguous and cannot qualify. Existing failed records without this proof are never reclaimed. No reserve, trading-fee posting or exchange invocation occurs in the qualified pre-dispatch failure path.

3. **P2 — A replaced/disabled forecast provider could continue suppressing a prediction exit.** `manageExits` previously chose the newest market forecast without assignment/provider/profile checks. It now requires a currently selected primary or explicitly enabled fallback, enabled provider, matching provider version and exact current forecast profile. Missing/invalid expiry, unavailable permitted forecast or changed rules triggers stale-signal exit handling. Exits still require executable SELL depth, minimum size and fresh central risk authorization at a bounded limit price.

4. **P1 — Pending BUY orders remained active after the loss/drawdown stop.** `manageExits` now cancels nonterminal BUY orders when that stop triggers. Protective SELL orders remain active. Unconfirmed live cancellation retains reservations and records the need for reconciliation.

## Verification and operational boundaries

`pnpm typecheck` and focused ESLint on the two edited worker files passed after these changes. Manual live cases remain to be checked in an authorized isolated wallet environment: an untracked resting order, cancellation racing a partial fill, a failed preflight followed by recovery/backoff, and a provider reassignment while holding a prediction position. The database-backed paper financial and restore drill is recorded separately in [financial-verification.md](financial-verification.md).

An ambiguous settlement without a persisted transaction hash/relayer ID remains blocked for explicit reconciliation; it is never resent automatically. Startup recovery of persisted settlement submission state is handled separately in `apps/worker/src/index.ts`. Historical market normalization and paper order replay changes are handled separately in the gateway/execution files; this document does not establish real exchange behavior for those changes.
