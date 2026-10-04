# API inventory

The browser uses `/api` on its own origin. Owner sessions use cookies. Sensitive writes additionally require a short-lived `x-step-up-token` returned by `POST /api/security/reauth`. Provider secrets are write-only; read responses expose configuration and `hasSecret`, never decrypted values. Check route implementation for the authoritative validation contract.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | PostgreSQL query and Redis ping; returns 503 if either is unavailable |
| GET/POST | `/api/auth/*` | Better Auth session/sign-in/sign-out handlers; public registration disabled |
| GET | `/api/dashboard` | Mode-scoped ledger metrics, runtime, readiness and evaluations |
| GET | `/api/events` | Authenticated snapshot event stream |
| GET | `/api/skills` | Versioned role guides and allowed tools |
| GET | `/api/settings` | Settings, version and model assignments |
| POST | `/api/security/reauth` | Owner password verification for a sensitive request |
| PUT | `/api/settings` | Validated settings plus `expectedVersion` |
| GET/POST | `/api/providers` | List redacted providers / create validated provider |
| PUT/DELETE | `/api/providers/:id` | Versioned edit / disable provider |
| POST | `/api/providers/:id/probe` | Probe configured model capability; reauthentication required |
| GET | `/api/providers/:id/models` | Explicit model discovery |
| PUT | `/api/assignments` | Primary provider and opt-in fallback per role |
| GET | `/api/wallet` | Public address and redacted readiness |
| POST | `/api/wallet/check` | Queue wallet readiness check |
| POST | `/api/control` | Pause, resume, emergency stop, paper or gated live activation |
| GET | `/api/market/:id/history` | Market price history |
| GET | `/api/table/:name` | Paginated/filterable mode-scoped records |
| GET | `/api/table/:name/export` | Mode-scoped CSV export |
| GET | `/api/detail/:name/:id` | Record details |
| POST | `/api/orders/:id/cancel` | Queue authorized cancellation |
| POST | `/api/orders/:id/replace` | Validated replacement of eligible order |
| GET | `/api/services` | Redacted versioned news/search configuration, key presence and spend |
| PUT | `/api/services` | `{expectedVersion, config, apiKey?}`; encrypted write-only Tavily key |
| POST | `/api/services/probe` | Reauthenticated connection check of saved configuration |
| POST | `/api/services/search` | Reauthenticated budgeted saved Tavily search; `{query}`; maximum five requests per minute |
| GET | `/api/trends` | Persisted public source items, publication/retrieval/freshness and matching market IDs |
| GET | `/api/evaluation/profiles` | Owner-only resolved historical profile inventory, up to 100 profiles |
| POST | `/api/evaluation/replay` | Reauthenticated bounded historical candidate assessment; maximum three requests per minute |
| GET | `/api/evaluation/books` | Available captured order-book snapshot count, market count and observation range |
| POST | `/api/evaluation/books/replay` | Reauthenticated independent two-leg FOK depth replay; maximum three requests per minute |

Tables: positions, orders, opportunities, decisions, history, forecasts, invocations and tools. Errors must remain visible to the operator; stale snapshots, missing prices and absent provider usage are not treated as successful data. UI control availability does not override server authorization, live gates or deterministic risk policy.

Services config has `news: {enabled, intervalSeconds, maxAgeHours, feeds: [{id,name,url,enabled,primary}]}` and `tavily: {enabled,costPerCreditUsd}`. Search budgets remain in main risk settings (`researchDailyBudgetUsd` / `researchMonthlyBudgetUsd`). Trend excerpts are unverified external data. Feed classification and lexical market matching do not establish resolution authority or market direction.

Manual search accepts a trimmed 1–1,000-character query without control characters and no extra fields. It uses the active operation mode, stored connection and normal research budget accounting. A failed request can still consume provider credits; review the persisted invocation record.

Candidate replay accepts exactly `{profileVersion, minimumEdge, lookbackDays, limit}`: a 20-character lowercase hexadecimal profile ID, edge 0.01–1, 7–365 days and 1–2,000 events. It persists a checkpoint assessment and does not modify live settings, assignments or orders. Profile inventory counts are raw resolved events and can exceed the valid prospective samples used for assessment. See [evaluation.md](evaluation.md) for scoring, cost attribution and promotion boundaries.
