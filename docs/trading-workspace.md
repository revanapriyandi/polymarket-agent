# Trading workspace

The trading interface uses a persistent navigation shell and separate React Router pages. Every submenu has a URL that supports direct entry, reload, bookmarks and browser back/forward. The existing React/Vite and authenticated Fastify stack is retained. Production Fastify serves the app entry for non-API routes; API endpoints retain their authentication and JSON errors.

| Menu | Pages |
| --- | --- |
| Ringkasan | `/` — equity, net P&L, daily P&L, available cash, performance chart, risk usage, active positions |
| Portofolio | `/portfolio/positions`, `/portfolio/orders`, `/portfolio/history` |
| Pasar | `/markets/opportunities`, `/markets/decisions` |
| Analitik | `/analytics/performance`, `/analytics/evaluation`, `/analytics/replay` |
| Riset | `/research/news`, `/research/forecasts` |
| Agent & sistem | `/system/agents`, `/system/health`, `/system/activity`, `/system/invocations`, `/system/tools` |
| Pengaturan | `/settings/risk`, `/settings/providers`, `/settings/services`, `/settings/wallet` |

Settings help remains a contextual drawer. Each Settings page has its own “Cara mengisi” action. Opening or closing help preserves the form draft; navigating to another Settings page leaves the current form. Sensitive changes and operational controls still require owner reauthentication. Live activation lives under system health and still uses server-side readiness and evaluation gates.

## Financial display rules

- Equity is cash plus marked position value minus accrued operating costs. Deposits are capital, not profit.
- Realized P&L already includes trading fees. Net P&L combines realized and unrealized P&L and subtracts operating costs once.
- Daily P&L follows the ledger's UTC day boundary. Missing equity also hides daily P&L and current drawdown.
- Pending settlement shows unfinalized fill notional plus fees; it is not an additional independent slice of cash allocation.
- Position average price, value and unrealized P&L are computed with PostgreSQL numeric arithmetic. Marks older than 120 seconds cannot appear as a current valuation.
- Charts show saved valuation history, with equity/P&L/drawdown selection, crosshair, time ranges and zoom/pan. Order markers are labeled as orders, not confirmed fills. Refreshing snapshots preserves the chart instance and selected range.
- Arbitrage opportunities show estimated net amount and edge after costs. Expired candidates are distinguishable from fresh candidates and rejected proposals.
- Paper and live records remain separated. Research/tools are explicitly labeled as cross-mode records.

## Table API additions

Existing `/api/table/:name`, `/api/table/:name/export` and `/api/detail/:name/:id` responses now include `question` and `marketSlug` where a market relation exists. Positions/orders/decisions include YES/NO `outcome` when their token matches the market. Forecast `outcome` retains its original numeric meaning.

Position responses add `averagePrice`, `markFresh`, `positionValue` and `unrealizedPnl`. Query `activeOnly=true` filters positions to positive shares, including recovery and pending resolution. On opportunities, `status=candidate` means an unexpired candidate and `status=expired` means an expired candidate. `rejected` retains its stored meaning.

Enrichment uses a bounded set of allowlisted queries and a single market join, without per-row requests. Search includes market names. CSV keeps the same filters and 10,000-row ceiling. Existing redaction and owner authentication remain in place. No database migration is required.

## Verification

Local release checks completed on 2026-10-04 (WIB):

- `pnpm build` passed TypeScript, frontend production bundling and backend/worker builds.
- `pnpm lint` and `git diff --check` passed.
- Browser inspection covered the overview and all 19 submenu URLs, direct reload, sidebar/submenu navigation and browser back.
- Real local market records displayed readable names, net arbitrage estimates and detail drawers. Empty states, search, pagination, status filters and CSV were checked independently.
- Chart metrics and ranges changed correctly; the chart canvas survived incoming snapshots after pan/zoom.
- Paper pause/resume required reauthentication and returned to running. Logout returned to the login page.
- Settings help retained a changed draft, supported search and returned keyboard focus after closing.
- Desktop 1440 px and mobile 390 px layouts were inspected. No horizontal page overflow appeared on the overview, opportunities, providers, services, health or evaluation pages. Tables retain their own horizontal scrolling where needed.

These checks used the running application and ad hoc browser/API inspection. No automated test suite was added. A non-blocking Vite warning remains for the main chart/application chunk above 500 kB; secondary pages are lazy loaded.

Release procedure follows [vps.md](vps.md): encrypted backup before replacement, exact source commit, sequential image builds, health checks, public HTTPS login and deep-route validation. Worker processing, provider credentials, paper results and real-money trading remain separate operational states.
