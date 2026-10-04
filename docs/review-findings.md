# Read-only correctness review — 2026-10-04

Source review only. No trading, SQL writes, paid provider calls or automated tests were performed. Lines below refer to the reviewed source snapshot and may move during remediation. Findings are reported to the implementation owner; this file is not proof that fixes passed acceptance.

## P1 — Strategy allocation ignores approved BUY reservations

`packages/core/src/risk.ts:47–52` sums strategy position cost basis, then adds only the new proposal. Existing reserved BUY orders are absent. Sequential proposals in distinct events can therefore pass the strategy limit while their combined strategy reservations exceed it, as long as overall/event exposure remains below those broader limits. Include strategy-specific BUY reservations in the same advisory-locked transaction, alongside position basis. Verify a second proposal is rejected at the allocation boundary without affecting permitted exits.

## P1 — Pending fills make P&L unknown without blocking other entries

`packages/core/src/ledger.ts:31–38` returns null equity/P&L when fills remain pending but substitutes zero for daily P&L and drawdown. `packages/core/src/risk.ts:27–29` checks only unmarked positions before using those zero risk values. A pending fill can therefore leave the portfolio unable to compute loss while a proposal for another market passes. Entry authorization should reject null equity/P&L or any pending settlement state; exits and reconciliation should remain available. Verify an unrelated market entry is blocked while a pending fill exists.

## P1 — Replacement bypasses disabled strategy and universe gates

`packages/core/src/risk.ts:19–29` does not enforce enabled entry strategy or minimum market liquidity/volume. Those checks exist in `apps/worker/src/strategies.ts:17`, but authorized order replacement enters the risk function directly using a refreshed policy version. Disabling the original strategy or reducing liquidity therefore does not reject a replacement entry. Centralize these current entry checks in the risk transaction, leaving exits exempt. Verify replacing a BUY after disabling its strategy fails, and an exit remains possible.

## P1 — Delayed research can forecast already closed markets

`apps/worker/src/pipeline.ts:54–72` fetches the current market but does not reject closed/resolved/inactive/non-orderable/ended markets before paid analysis and forecast storage. A queued job can process after resolution. `pipeline.ts:81` stores resolution detection time (`now()`), and `packages/core/src/evaluation.ts:11` accepts forecasts created before that detection timestamp. This can count hindsight predictions as prospective scoring data. Reject invalid markets before spending, recheck before publishing, and exclude forecasts created after the market cutoff or confirmed resolution time; do not treat detection time as the occurrence time. Verify a queued research job for a closed market performs no paid calls and is excluded from calibration.

## P2 — Risk/execution entry runs are absent from agent runtime accounting

`apps/worker/src/index.ts` initializes risk to waiting. `packages/core/src/risk.ts` and `apps/worker/src/strategies.ts` invoke entry authorization/execution directly without a `runTool` / task boundary or agent state updates. Their actual decisions/orders exist, but the role dashboard can continue showing no role runs while those operations occur; per-role tool limits also do not cover those direct calls. Add persisted role execution boundaries around authorization and execution, including exits, without recursively wrapping the same call. Verify decisions/orders correspond to risk/execution tool records and real runtime counts.

## P2 — Live fallback remains disabled regardless of profile eligibility

`packages/core/src/ai-service.ts`, `candidates`: live mode skips every explicitly selected non-primary provider. `profiles.ts` / `evaluation.ts` create exact fallback profiles, and risk authorization checks exact profile eligibility, so the blanket skip prevents even an independently eligible enabled fallback. Either expose the deliberate primary-only live policy in UI/docs, or allow explicit fallback candidates subject to their own exact evaluation gates. Never reuse primary evidence to authorize fallback.

## P2 — Old model forecast suppresses regeneration

`apps/worker/src/pipeline.ts:41` treats any unexpired forecast with matching rules as fresh. It does not require current assigned provider/version/profile. `strategies.ts:39–42` correctly rejects incompatible records, leaving the worker waiting until that rejected forecast expires rather than generating the newly selected model's result. Apply the same allowed-model/version/profile predicate to the freshness check. Verify changing forecast assignment schedules a new forecast despite an old unexpired record.

## Examined properties without a new finding

- Risk reservations and fill settlement use the same PostgreSQL advisory transaction lock.
- Journal postings round to bounded precision and reject unbalanced totals; journal IDs make service charges idempotent.
- Invocation reservations lock the provider row, include unknown reserved costs, and use daily/monthly/concurrency/rate gates. Completion posts usage and cost atomically; bookkeeping errors propagate instead of initiating another paid call.
- Profile hashing includes model/assignment/fallback/risk identity and evaluation filters exact model profiles. Unknown/unposted service costs and invalid ledgers block eligibility.
- Entry proposals count correlated markets within the same event. No explicit contract for cross-event correlation grouping was present in the reviewed schema.
- Complementary arbitrage uses depth-level fees for quoting; portfolio settlement/execution reconciliation is reviewed separately by another owner.

## Remediation evidence - profile/research scope

Implemented exact independently evaluated forecast fallback selection for live mode; upstream analysis fallback stays primary-only live and assignments remain bound into profile identity. Scanner freshness now matches current permitted provider/version/profile and invalidates active forecasts when rules change or market midpoint moves by the configured minimum-edge threshold. Research revalidates current market and run policy before search, every paid analysis/forecast candidate, and publishing. Calibration requires forecast creation before the current market cutoff and matching rules; resolution detection time alone is insufficient. Reconciled alias fills no longer count as pending evaluation work.

Interrupted running AI invocations older than ten minutes are recovered under the provider lock on the next reservation. Unknown cost retains its maximum reservation and posts with the original idempotent journal ID, freeing concurrency without refunding uncertain usage or billing twice. This recovery is demand-driven; providers receiving no further calls retain running state until a reservation attempts recovery.

Validation: full TypeScript typecheck passed after implementation. No paid calls, trading, secrets, migrations, or automated tests were performed for these changes. Runtime acceptance with closed/inactive queued markets, provider interruption, assignment changes and independently qualified fallback remains to be exercised with controlled fixtures.
