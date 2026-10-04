# Local implementation and verification — 2026-10-04

This report separates source implementation, local runtime observations, controlled fixtures and the gates still requiring real services or elapsed paper trading. It is not a profit report or a production deployment certificate. No automated test suite was added.

## Environment and current state

- Windows, Node 24.14.1, pnpm 10.33, PostgreSQL 18.2 at port 5433, dedicated Redis 8.8.3 at port 6380.
- Dashboard: `http://127.0.0.1:5173`; API: port 4100. API and worker were also launched successfully from the compiled `dist/server` entry points. Vite serves the local development UI. A separate compiled API/frontend on port 4102 was used only for the isolated database drill.
- Main mode is **paper / running**. Seed capital, cash and equity are **1,000 pUSD**. Verified net P&L, fees and service costs are **zero**; no main-database orders, fills or AI invocations were present at the recorded check. This is virtual capital, not a funded live wallet.
- Actual Polymarket discovery completed with 40 selected markets per scan; 54 market records had accumulated in storage. Market WebSocket and the operations/discovery/research queues reported readiness on the active worker PID.
- BBC World and Federal Reserve public feeds are configured. The UI displayed actual retrieved news with publication/retrieval times, freshness and explicitly unverified excerpts. Tavily is disabled without a key and positive research budgets. No paid search was performed.
- AI providers and role assignments in the main database are absent. The readiness panel reports AI and wallet as unconfigured, research as degraded with public feeds available, and live evaluation as blocked.

## Source and build checks

`pnpm lint` and `pnpm build` completed successfully after the final dispatch-permit changes. Build includes `tsc --noEmit`, the Vite bundle and the API/worker bundles. Earlier financial-report type errors were resolved before these final checks.

The production frontend bundle is approximately 625 kB before gzip / 194 kB gzip after localized Settings labels. Vite emits a nonfatal chunk-size warning above 500 kB. No build failure was hidden by that warning. Docker Compose configuration was validated earlier, but an actual Docker image build and VPS deployment were not run because the local Docker daemon/target VPS were unavailable.

## Browser and API evidence

The dashboard was exercised with Playwright as a manual browser session, with no checked-in browser test suite.

| Flow | Observed result |
| --- | --- |
| Owner login and authenticated dashboard | Successful; public signup disabled |
| Unauthenticated dashboard API / mismatched Origin | 401 / 403 |
| Incorrect owner step-up password | Rejected with an explicit password error |
| Paper resume, pause and emergency stop | Successful through UI and password step-up; final state resumed to paper/running |
| Live activation before readiness | 409 with an explicit gate reason; no live transaction |
| Settings save and concurrency | Isolated valid write 200; stale version 409; invalid risk 400 |
| Provider secret storage | Isolated fake secret encrypted at rest and absent from returned JSON; only presence exposed |
| Untested provider assignment | Rejected |
| Provider probe with zero budget | 409, `Budget provider tidak cukup untuk reservasi biaya maksimum`; no model HTTP call or invocation |
| Official/custom protocol selection | All seven choices visible, including separate Chat, Responses and Anthropic-compatible protocols |
| Record table | Pagination, details and capped CSV export exercised; shared audit/tool data explicitly labeled |
| News list | Search and eight-item pagination exercised; source links/dates/freshness visible |
| Captured-book replay | Seven actual observed book snapshots produced seven no-trade decisions, zero paired net and a saved candidate ID; no profit invented |
| Forecast assessment | Empty state explicitly requires resolved prospective forecasts |
| Chart | 320-pixel chart viewport; pan/zoom and crosshair exercised. Time-axis pixels remained identical across changed SSE snapshots after panning |
| Desktop / mobile | 1440×1000 and 390×844; mobile document width 390 and settled drawer width 390, with no horizontal document overflow |
| Browser errors | No page errors in the completed manual session |
| Compiled frontend | Loaded the built asset bundle through the isolated compiled API |

Screenshots: `artifacts/dashboard-viewport.png`, `artifacts/dashboard-mobile.png`, `artifacts/settings-mobile.png`, `artifacts/replay-desktop.png`, and `artifacts/chart-pan.png`. They represent the captured state and can differ from later live observations. The wide replay table scrolls inside its own container on small screens.

## Runtime recovery and exchange restrictions

The real local worker was stopped while the API remained available. Dashboard worker, queue and market readiness became degraded. Starting the compiled worker restored heartbeat, queue completion and market-feed readiness. `scripts/worker-health.ts` then exited successfully. The before/after main ledger remained 1,000 paper cash, two journals, zero orders and zero fills. This particular restart had no in-flight main orders; duplicate-fill safety was checked separately with controlled financial records.

An isolated database recovery drill inserted two live order states and three settlement states without calling any exchange:

- A `preparing` order became rejected and released its reservation.
- A `submitting` order became ambiguous and retained its reservation.
- A prepared settlement with the new operation fingerprint/attempt contract became an explicit pre-dispatch failure eligible for bounded retry.
- A submitting settlement became ambiguous. A legacy prepared record without proof of non-dispatch remained blocked.
- Running recovery again changed none of these records; journals remained unchanged.

Eight controlled exchange-request scenarios passed: SDK rate-limit classification, blocking before another network call, restoring a supplied 60-second delay, explicit restart classification, the two-minute post-only window, independent maker/cancel handling, preserving ambiguous transport writes, and never interpreting an unclassified 503 as cancel-only permission. No exchange order was sent by this drill. Two additional dispatch checks confirmed that already-expired permits and permits expiring during geographic preflight both block before POST; the observed POST count was zero.

The final classifier check additionally confirmed that an unclassified HTTP 500/503 or timeout 408 remains ambiguous for writes. Only explicit client rejection, rate limit, engine restart or an identified post-only restriction establishes non-acceptance. Unknown server failures do not release funds just because an HTTP response arrived.

Live signing now requires fresh books, an unchanged current policy and the consumed exact-intent permit still within its original 15-second expiry. Expiry is checked after signing and immediately before dispatch. Settlement polling uses durable transaction identities on later pulses instead of waiting for chain finality inside the operations queue. Forecast-resolution reads use a separate discovery job, at most five markets concurrently, with a durable cursor.

Machine-readable local evidence is retained under ignored `.runtime/recovery-verification.json` and `.runtime/restart-verification.json`. Error/cooldown details are persisted in `system_state` without credentials. See the official [matching-engine restart and restriction contract](https://docs.polymarket.com/trading/matching-engine) used for the implementation.

## Accounting and encrypted restore

The earlier isolated financial drill covered twelve scenarios, including reservation/allocation caps, maximum spend, immutable duplicate fills, pending-settlement entry rejection, protective exits, invalid intent identity/numbers and balanced journals. Its results and exact boundaries are in [financial-verification.md](financial-verification.md).

A fresh final archive `.runtime/final-snapshot-1791125764030.pmbk` was encrypted using the actual backup implementation and restored into the new empty database `polymarket_restore_final_1791125764030`. Restore exited zero, authenticated the complete archive, compared every public-table count and verified journal balances. Its manifest included 12 book snapshots, 54 markets, 25,697 tool observations, 39,119 checkpoints, two journals and four ledger entries. These counts describe that database snapshot, not the subsequently running application. Main source data was not overwritten. Evidence: `.runtime/final-restore-verification.json`.

This proves the local PostgreSQL backup/restore path. Off-host archive retrieval, wrong-key/corruption drills, Redis recovery, VPS disaster recovery and long-duration concurrent-load testing still require their own run.

## Provider and replay verification boundaries

[provider-verification.md](provider-verification.md) records 27 actual HTTP requests against controlled Chat Completions, Responses and Anthropic Messages fixtures, and 17 endpoint/header rejection checks. The probes used the installed AI SDK adapters and actual guarded transport. These establish protocol wiring and defensive behavior for those payloads, not authentication, model quality, billing or complete capabilities of a real provider.

The replay implementation has also been exercised with synthetic paired, one-sided, missing/stale, insufficient-depth and unsupported-fee cases. A one-sided result never gets a fabricated net profit. Actual observed-book replay and all candidate evaluations remain independent of the financial ledger and cannot promote live eligibility. See [evaluation.md](evaluation.md).

## Owner configuration still needed

Deployment status was subsequently verified in the [2026-10-04 VPS release report](release-2026-10-04.md). The local evidence and original pending checklist below remain historical; they do not override the newer release evidence.

1. In Settings → Provider AI, save an official/custom connection, explicit model, prices and daily/monthly budget. Run its capability probe and assign research, evidence and forecast roles; summary is optional. Fallbacks require explicit selection and their own capabilities/evaluation.
2. In Settings → Layanan, save/enable a Tavily key and probe it after setting positive research budgets. Public RSS monitoring already works; it does not replace verified research evidence.
3. For live preparation, configure a dedicated funded wallet, server-side signer, CLOB credentials, Polygon RPC, relayer, allowances and local eligibility as documented in [polymarket.md](polymarket.md). Configure live capital and accepted limits in Settings. No secrets should be pasted into chat or committed to source.
4. Collect prospective paper evidence for the exact engine/model/skill/policy profile: at least 30 days, 100 completed trades, positive net result after costs, acceptable drawdown and no unresolved reconciliation; prediction also needs at least 50 resolved events and calibration better than its baseline. Engine version is 1.3.0; prior profiles do not inherit eligibility.
5. Deploy to the chosen VPS/domain using [deployment.md](deployment.md), verify HTTPS/login/health/recovery, then explicitly activate live only after the gates pass. Local background processes do not establish permanent VPS operation or continuous 24/7 availability.

Implementation, configured services, paper performance, live activation and real-money outcome remain separate states. No real provider bill, live order, wallet settlement, production deployment or real profit is claimed by this report.

## Local startup and handoff follow-up

`scripts/start-local.ps1` was executed against the actual local installation. The first run exposed a PowerShell argument-list quoting issue in the Vite config path; the argument construction was corrected before readiness was reported. Subsequent startup and repeated startup both exited zero. Existing API/worker processes were reused without duplicate processes. The final compiled bundle was then started through the same helper, with successful API, dashboard and worker health checks.

Settings now names risk/cost fields in Indonesian with pUSD, USD, ratio, bps, seconds and millisecond units. The UI explains 0.01 = 1% and 100 bps = 1%, presents readable official/custom protocol choices, and shows a full `/responses` URL hint only for Custom Responses. This selector and risk labels were exercised in the browser. The Indonesian [getting-started guide](mulai.md) covers startup, provider assignment, Tavily, wallet preparation, manual checks and remaining live/VPS gates.
