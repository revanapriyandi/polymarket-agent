# Polymarket operations

Owner-only dashboard, API and independent worker for bounded research, deterministic risk checks, paper trading and gated live execution. The dashboard reads persisted worker state, ledgers, provider invocations and evaluations. Paper profits are virtual; pUSD collateral and estimated USD service costs are displayed separately. There is no guaranteed return.

## Local operation

Requirements: Node 24, pnpm 10, PostgreSQL and Redis. Inspect `.env.example`, copy it to an untracked `.env`, and set the required local connection/auth/encryption configuration. Do not commit credentials. Keep live execution disabled during setup.

1. `pnpm install --frozen-lockfile`
2. Start PostgreSQL and Redis with your configured local services or the [Compose runbook](docs/deployment.md).
3. `pnpm db:migrate`
4. `pnpm owner:create` — follow the owner initialization prompt.
5. `pnpm dev` — API, worker and Vite UI run independently; the dashboard is at `http://127.0.0.1:5173`.
6. Configure provider/model assignments and budgets in Settings. Each tab has **Cara mengisi** with searchable field explanations, examples, limits and troubleshooting. A key being saved does not prove model compatibility; use Probe and inspect reported capabilities.

For deployment, encrypted backups and isolated restore drills use [deployment.md](docs/deployment.md). Existing Nginx hosts use [the VPS runbook](docs/vps.md). Creating those artifacts does not prove a production deployment or a successful restore.

On Windows, the optional `pwsh -File scripts/local-services.ps1` starts this project's isolated PostgreSQL on `127.0.0.1:5433` and Redis on `127.0.0.1:6380`. Follow the [Windows runtime setup](docs/deployment.md#windows-local-runtime) first. The helper waits for database/Redis readiness and fails if database lookup or creation fails; it does not migrate or create the owner. For the reproducible foreground application startup, run `pnpm dev` after those steps. Ctrl+C stops its API, worker and Vite processes; PostgreSQL/Redis are separate processes. If another application occupies an app port, investigate that process instead of terminating it blindly.

For one-command Windows startup after installing dependencies and creating the owner, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1`. It starts/reuses the isolated services, migrates and builds when no application process is running, then starts hidden compiled API/worker processes plus Vite. It verifies API, UI and matching worker/operations health before reporting readiness. Repeated invocation reuses its tracked processes; conflicting PIDs/ports fail without terminating unrelated applications. `-SkipBuild` explicitly reuses an existing build. This helper requires the local loopback defaults and live execution disabled. It does not change saved trading controls or configure a Windows boot service.

Panduan konfigurasi dalam Bahasa Indonesia: [mulai dan konfigurasi](docs/mulai.md).

| Command | Implemented entry point / result |
| --- | --- |
| `pnpm dev` | Runs the three development commands concurrently |
| `pnpm dev:api` | `tsx watch --env-file=.env apps/api/src/index.ts`; API port 4100 |
| `pnpm dev:worker` | `tsx watch --env-file=.env apps/worker/src/index.ts`; independent queues and heartbeat |
| `pnpm dev:web` | Vite with `apps/web/vite.config.ts`; strict port 5173, `/api` proxy to 4100 |
| `pnpm db:migrate` | `scripts/migrate.ts`; applies database migrations |
| `pnpm owner:create` | `scripts/create-owner.ts`; creates the first owner, refuses replacement |
| `pnpm typecheck` / `pnpm lint` | TypeScript / ESLint checks |
| `pnpm build` | Typecheck, Vite web build, then API/worker server bundles |
| `pnpm start:api` | Node with `.env`, `dist/server/api/src/index.js`; requires a successful build |
| `pnpm start:worker` | Node with `.env`, `dist/server/worker/src/index.js`; requires a successful build |
| `pnpm exec tsx --env-file=.env scripts/worker-health.ts` | Checks recent worker and operations queue heartbeat, including matching worker PID |

Owner password input in `owner:create` is visible in the terminal. For unattended provisioning, supply `OWNER_INITIAL_PASSWORD` through private process environment delivery; do not place the password in command arguments or logs.

## Structure and contracts

- `apps/web`: React owner console, responsive records, agent details and reauthenticated controls.
- `apps/api`: owner authentication, versioned settings, secrets, tables and control routes.
- `apps/worker`: autonomous jobs and runtime heartbeat, independent of the browser.
- `packages`: shared contracts, provider integrations, research, accounting and agent policies.
- [API inventory](docs/api.md), [acceptance checklist](docs/acceptance.md), [agent tools](docs/skills-tools.md), [provider configuration](docs/ai-providers.md), [Polymarket contracts](docs/polymarket.md).
- [Candidate evaluation](docs/evaluation.md) documents bounded historical assessment without order creation or automatic promotion; [financial verification](docs/financial-verification.md) records the local isolated database/restore drill.
- [Final local verification](docs/verification.md) separates compiled/runtime/browser evidence, provider fixtures, recovery drills, and the outstanding real-provider, paper-duration, live and VPS gates.

## Verification boundaries

`pnpm typecheck`, `pnpm lint` and `pnpm build` verify source/build properties. Browser operation, real provider usage, sustained paper performance, live trading, deployment and restore integrity require separate evidence. The current implementation is not evidence of thirty days of paper trading or real profit. See the acceptance checklist for the required manual gates.
