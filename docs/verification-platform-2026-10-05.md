# Platform expansion verification — 5 October 2026

This report covers the source release before VPS replacement. Production evidence is collected separately against the deployed commit; a local build does not establish production market connectivity or funded-wallet readiness.

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

No automated test suite was added. Browser checks exercise real controls; screenshots are held in ignored local `artifacts/` to keep owner/session data out of the public repository.

## Remaining external verification boundaries

- The Windows environment could not reliably fetch Polymarket HTTP data. Real price history, depth streaming, event timing and reconnect verification must therefore be measured on the VPS after deployment. A configured 100 ms coalescing interval is not a latency or fill guarantee.
- Builder credentials have not been supplied. Actual account creation, allowance transactions, funded balance checks and ambiguous relayer reconciliation have not been exercised against a real wallet.
- Paid AI/search providers and capability-qualified role assignments remain unconfigured. Research UI/checkpoints and authorization are verified; paid provider execution and forecast quality are separate gates.
- No real orders were submitted. Paper history, strategy evaluation and live activation retain their existing conditions; this release does not certify profitable trading.

See [platform operations](platform-operations.md) for endpoint contracts, data semantics, wallet recovery and deployment order.
