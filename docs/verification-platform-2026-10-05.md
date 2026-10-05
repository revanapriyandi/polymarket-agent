# Platform expansion verification — 5 October 2026

This report distinguishes source checks, production market/UI observations and external operations that still require credentials. A successful build does not establish funded-wallet readiness.

## Scope and manual coverage

| Area | Check | Result before deployment |
| --- | --- | --- |
| Static checks | `pnpm lint`, `pnpm build` (including TypeScript), `git diff --check` | Passed |
| Database | Apply additive migrations 0004 and 0005 | Passed on local database |
| Owner access | Login, authenticated analytics/markets/queues/wallet/stream endpoints | HTTP 200; mode paper |
| Wallet security | Missing step-up, missing setup after reauthentication, invalid credential schema | HTTP 403, 409 and 400 respectively; no signer/account created |
| Secret boundary | Inspect public wallet response field names | Public addresses, status, readiness only; no private key or Builder/CLOB credentials |
| Wallet guidance | Open setup form and help drawer | Three masked Builder fields, disabled empty submit, instructions and separate live requirements |
| Analytics | Load mode-scoped breakdown, select 7/30-day periods, download daily CSV | Passed; unavailable performance/calibration stays empty |
| Terminal | Search watchlist, switch YES/NO and 1D/7D, toggle SMA, reset zoom | Passed; no browser JavaScript errors |
| Research | Read rules, tool checkpoints, empty forecasts and prerequisites | Passed; paid/manual research unavailable without tested models and budgets |
| Sidebar | Desktop at 1440×620: idle and hover scrollbar | Thin transparent scrollbar at rest; visible thumb on hover; menu remains scrollable |
| Responsive UI | Desktop 1440×1000 and mobile 390×844 | No page-level horizontal overflow; watchlist labels wrap within their cells |
| Off-happy-path data | Local external HTTP/DNS failures and unverified exchange timestamps | Explicit unavailable/stale state; no fabricated history or quote freshness |
| VPS recovery preparation | Encrypted backup before migration/replacement | `polymarket-20261005T020657Z.pmbk`; prior services healthy and NTP synchronized |

No automated test suite was added. Browser checks exercise real controls; screenshots are held in ignored local `artifacts/` to keep owner/session data out of the public repository. Review also verified timestamp serialization through credential redaction, removed expired contracts from the active catalog, tied historical model names to their recorded provider version, and clamped browser age displays at zero between clock ticks.

## Production observations

Measured against platform build `4bafadd527c39a4beb657e195f626cdbb8014e30` at `pm.rnevio.com` on 5 October 2026, with owner authentication and paper mode:

- API, worker, PostgreSQL and Redis health checks passed. Real WebSocket observations covered 80 subscribed tokens; one sample had 38 quotes within the 2-second freshness limit and 66 reconstructed depth books. These are snapshots, not permanent freshness guarantees.
- A 15-second SSE observation captured 117 packets and 456 quote delivery samples after omitting initial cached snapshots. Worker receive-to-publication delay was P50 46 ms, P95 93 ms, maximum 115 ms. Browser inter-update intervals were P50 107.2 ms and P95 252.2 ms. This does not measure end-to-end network or order-fill latency.
- Official history returned 286 one-day samples in a spot check. YES/NO switching, 1D/7D/30D ranges, a second-market comparison, SMA, zoom reset and PNG download worked without browser JavaScript errors. Daily analytics CSV export also worked.
- The research workspace displayed real contract rules and recorded tool checkpoints, with explicit missing-model and budget prerequisites. No forecast was invented and no paid provider was called for verification.
- Paper equity/cash remained 1,000 pUSD, with zero P&L and exposure in the verification snapshot.
- Post-migration encrypted backup `polymarket-20261005T021943Z.pmbk`, SHA-256 `23e956ed189fac73187a79f3c88e7842454c353f15521eaa63db7e1bca5955c3`, restored successfully into an isolated database. Public table counts, balanced journals and all 11 wallet constraints were verified. The managed-wallet table was empty. The temporary database was removed after verification. The restore role must own the isolated database; the initial attempt correctly rolled back when schema-creation permission was absent.

## Remaining external verification boundaries

- The Windows environment could not reliably fetch Polymarket HTTP data. Real price history, depth streaming and timing were verified through the VPS instead. A configured 100 ms coalescing interval is not a latency or fill guarantee; short samples do not establish long-term latency percentiles.
- Builder credentials have not been supplied. Actual account creation, allowance transactions, funded balance checks and ambiguous relayer reconciliation have not been exercised against a real wallet.
- Paid AI/search providers and capability-qualified role assignments remain unconfigured. Research UI/checkpoints and authorization are verified; paid provider execution and forecast quality are separate gates.
- No real orders were submitted. Paper history, strategy evaluation and live activation retain their existing conditions; this release does not certify profitable trading.

See [platform operations](platform-operations.md) for endpoint contracts, data semantics, wallet recovery and deployment order.
