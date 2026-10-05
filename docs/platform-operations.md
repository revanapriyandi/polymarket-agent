# Trading workspace operations

## Live data

`/markets/terminal` subscribes through the authenticated SSE connection. Official Polymarket WebSocket events are validated in the worker, merged for delivery on a 100 ms timer, cached in Redis and pushed to the API. The account summary uses a separate 5-second timer. The browser never authorizes trades.

Price observations preserve exchange and worker timestamps. Book snapshots can contain an old last-change timestamp: event age is not a pure measurement of network latency. Browser freshness estimates use the worker clock plus elapsed browser time; keep the VPS synchronized with NTP. WebSocket connection health, individual price age, display-book age and strategy queue time are separate measurements. A silent market is not displayed as a fresh quote simply because another token has an update.

The stream maintains display depth from initial book snapshots and price deltas; disagreement with the advertised top of book invalidates reconstructed depth. The terminal then labels the REST snapshot explicitly. Streaming depth is never execution authority. Historical chart points are official sampled prices, not invented candles or trade volume. Live chart points are bid/ask midpoints. The SMA uses historical samples; comparison uses another market's YES series.

Entry requires a connected feed, an individual WebSocket quote no older than 2 seconds, and an authoritative REST book no older than 1 second. Signals older than 2 seconds when the signal worker starts are dropped. Positive gross candidates enter a dedicated queue with a single active/waiting job per market; full fee, depth, profile and risk checks still apply. A per-market PostgreSQL lock coordinates stream and discovery proposals. Reconnect clears stream state; initial worker startup invalidates the previous stream before opening jobs. Risk exits and reconciliation remain independent of the entry freshness guard.

Price changes on held markets also queue position valuation and exit/risk checks without waiting for the periodic 15-second portfolio scan. Held markets remain subscribed even when they leave the discovery shortlist. Cancellation and user-stream reconciliation take precedence over these coalesced per-market checks; the periodic scan remains the recovery path.

These are validation limits, not execution or fill guarantees. The deployment is not an HFT venue. A market may have insufficient depth, a stale timestamp, no positive net edge or an expired forecast; waiting is expected. Paper execution retains its configured latency and failure model. No real order is placed merely to measure latency.

`/system/latency` exposes real worker samples (last 200, 24-hour retention). Queue duration, validation duration and total handling duration do not establish real-money fill latency. Quiet markets may legitimately produce no candidate samples.

## Dedicated server wallet

1. Open Settings → Wallet → Siapkan koneksi awal. Obtain Builder key, secret and passphrase from your own Polymarket account's Settings → Builders. The SDK's Builder integration must be available to that account.
2. Save using owner reauthentication. A dedicated signer is generated server-side with viem and stored, together with credentials, as AES-256-GCM ciphertext. API responses, audit records and model tools never return the key. The one-owner database row has status/address constraints.
3. Select Hubungkan wallet. The worker checks eligibility, uses the official SDK's Deposit Wallet setup/authentication, persists its identity and CLOB credentials, then sets trading approvals. No entry or live activation happens as part of this setup.
4. Fund only the confirmed account/funder address, configure live capital/risk, and verify balance/allowance. The signer address is a different identity. Preserve `MASTER_KEY`, `BACKUP_KEY` and encrypted database backups in separate recovery locations before funding.
5. Live activation remains gated by server configuration, paper evaluation, owner risk acknowledgement, reconciliation and wallet readiness. There is no withdrawal tool for agents.

`POLYGON_RPC_URL` can be configured by the VPS operator. Otherwise the application uses viem Polygon's default public RPC. Arbitrary RPC endpoints are not accepted through the web form. Legacy environment wallet configuration remains supported; it takes precedence over managed setup. Changing managed credentials is blocked while live mode or live exposure is active.

An interrupted setup is marked ambiguous; the same signer is retained. Do not reset its row or generate a replacement. If account identity and credentials were already persisted, inspect the original relayer operation, then run the read/check-only reconciliation command:

```
node --import tsx scripts/reconcile-managed-wallet.ts --confirm-existing-account
```

Supply the normal production environment securely through Compose. This command verifies the already deployed account, authentication, eligibility and allowances before restoring connected state; it does not deploy, submit allowance transactions or activate live. If no identity was persisted, or allowances are incomplete, recovery stays blocked pending external confirmation. Backups contain encrypted signer material and require the original master key.

## Analytics, research and agents

`/analytics/performance` compares completed markets by strategy, net trading P&L, win rate, expectancy and profit factor; operating costs are shown separately. Closed YES/NO legs of one arbitrage market are grouped. Daily changes use UTC closing valuation snapshots, omit unknown initial baselines and exclude deposits through ledger P&L. Current exposure is not a historical-period metric. Calibration uses the first forecast per market before outcome and is explicitly labelled as a shared research dataset; live evaluation is still per strategy/profile.

`/research/workspace` shows saved resolution rules, timestamped evidence, source links, supporting/opposing references, forecast intervals, expired/abstain states and checkpoint stages. Manual research requires owner reauthentication, tested role assignments, configured budgets, running control and a supported market. Repeated requests within 30 minutes share the same job ID. The existing pipeline rechecks budgets, policy, source configuration and rules before every paid stage. No model/provider response is fabricated when credentials are absent.

Agent detail drawers show skill permissions/version and the latest 30 actual tool runs. Health displays operation, discovery, research and streaming queues. A tool's existence alone is not evidence of a successful runtime call.

## API additions

All endpoints require the owner session; writes also require exact Origin and short-lived step-up authentication.

| Endpoint | Purpose |
| --- | --- |
| GET `/api/market-stream` | Cached quote/depth snapshot and connection state |
| GET `/api/events` | `quotes`, `snapshot`, `market-unavailable`, `unavailable` SSE events |
| GET `/api/market-stream/timings` | Recorded strategy timing samples |
| GET `/api/markets?search=` | Stored active market catalog, maximum 200 |
| GET `/api/markets/:id/chart?outcome=YES&range=1D` | Official historical samples; ranges 1D, 7D, 30D |
| GET `/api/markets/:id/book?outcome=YES` | Fresh authoritative REST depth snapshot |
| GET `/api/analytics?days=30` | Mode-scoped ledger analytics, 1–365 days |
| GET/POST `/api/research/:id` | Dossier / bounded durable research request |
| GET `/api/agents/:role/runs` | Last 30 runtime tool results |
| GET `/api/queues` | Queue counts |
| GET/PUT `/api/wallet/setup` | Public setup view / encrypted Builder configuration |
| POST `/api/wallet/connect` | Queue dedicated account setup or readiness check |

Deploy migrations `0004_managed_wallet` and `0005_wallet_constraints` after an encrypted backup and before replacing API/worker. These migrations only add a new table and constraints. The frontend sidebar scrollbar is thin, transparent until hover or keyboard focus, and remains visible to touch users when scrolling is available.
