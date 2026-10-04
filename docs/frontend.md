# Frontend operations dashboard

React 19 / Vite single-page owner console. Entry `apps/web/src/main.tsx`, layout and owner authentication `App.tsx`, risk/provider/wallet configuration `Settings.tsx`, actual equity visualization `Chart.tsx`, paginated records and order control `DataTable.tsx`, accessible Radix dialog `Drawer.tsx`, same-origin request helper `api.ts`, responsive charcoal/mint styling `styles.css`.

The frontend follows `docs/CONTRACT.md` and shared Zod schemas. Better Auth uses server cookies. No passwords, provider secrets, wallet private keys, or step-up tokens are persisted in browser storage. Provider secrets are blank on edit and only submitted when changed. Sensitive operations obtain one password reauthentication token and send it through `x-step-up-token`; cancelling the dialog cancels the pending action. Settings writes include expectedVersion and the form refreshes after successful save.

Dashboard and agent metrics come from API snapshots, supplemented by credentialed SSE snapshot events. Polling continues every 30 seconds if SSE disconnects; stale/offline notice remains visible. Tables poll every 15 seconds, use server search/status/pagination, export through authenticated same-origin CSV links, and sort the currently loaded page only. Detail drawers show stored data. Order actions appear only for actionable statuses and require server authorization and confirmation.

Lightweight Charts 5.2 provides crosshair values, pan, scroll zoom, and 24H/7D/30D/all ranges. BUY/SELL arrows come from up to 100 stored order records for the current mode, positioned at the nearest stored equity timestamp. The UI explicitly identifies arrows as order records rather than confirmed fills. No chart points, trades, metrics, provider capabilities, or agent activity are simulated by the browser. Empty states remain empty until real worker results exist.

All seven provider protocols are selectable. Settings expose model/endpoint, explicit fallback, role assignments, concurrency, retry/rate limits, token limits, timeouts, daily/monthly budget, token prices, capability probes, and model discovery. Wallet controls only save the public address and risk acknowledgment; signing keys remain server configuration. Live eligibility and readiness are enforced by the server.

## Run and verify

Use root dependency installation and `pnpm dev:web`. Vite listens on 127.0.0.1:5173 and proxies `/api` to port 4100. For production, run the Vite build and serve `dist/web` through the API. Focused commands:

- `pnpm exec tsc --noEmit -p apps/web/tsconfig.json`
- `pnpm exec eslint apps/web/src`
- `pnpm exec vite build --config apps/web/vite.config.ts`

No automated tests were generated, following the user's instruction. Manual acceptance requires a running API, database, worker, and owner account:

1. Sign in with the owner, verify wrong-password feedback, logout, and anonymous access boundaries.
2. Verify initial empty metrics and charts reflect actual stored state; let the worker save a valuation and observe SSE changes.
3. Disconnect the API and confirm offline/error states and retry behavior; reconnect and confirm recovery.
4. Inspect all nine agents, skill contracts, readiness reasons, and paper-to-live gate reasons.
5. Search and filter each records tab, paginate, sort the current page, open detail, and export CSV.
6. Configure each provider protocol as needed, verify secret fields remain blank on edit, probe capabilities, discover models, and save primary/fallback assignments.
7. Save valid/invalid risk profiles, wallet address, and acknowledgment; verify server version conflicts cannot silently overwrite settings.
8. In paper mode, exercise pause/resume/emergency and order cancel/replace. Cancel reauthentication to ensure no write occurs. Do not activate live without intentional owner authorization and passing gates.
9. Inspect widths 1440/768/390px, keyboard focus, Escape dismissal, drawer focus trap, and reduced-motion setting.

Compilation/build evidence alone does not establish authenticated browser acceptance, provider connectivity, wallet funding/allowances, order execution, or live readiness.
