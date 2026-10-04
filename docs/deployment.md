# Deployment and recovery

These are deployment artifacts and a runbook. No remote host, DNS, certificate issuance or production release is verified by creating them. Deploy only after the application build and paper-mode workflow are verified.

## Environment and secrets

Copy `.env.example` to `.env` outside source control. Set `APP_DOMAIN` to your DNS hostname and `APP_ORIGIN` to its exact HTTPS origin. Set `DATABASE_URL` to the internal PostgreSQL connection at `postgres:5432/polymarket`, percent-encoding the password, using the dedicated application role password. `POSTGRES_PASSWORD` is the separate PostgreSQL administrator password; never use that administrator credential in `DATABASE_URL`. Set `OWNER_EMAIL`. Generate `BETTER_AUTH_SECRET` with at least 32 random bytes. Generate distinct base64 32-byte `MASTER_KEY` and `BACKUP_KEY`, for example using `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` separately for each key. Store keys in a secret manager and an independent recovery location. Neither the backup key nor the provider master key should accompany backup archives.

Leave `ENABLE_LIVE_EXECUTION=false` for first deployment. Wallet/provider credentials remain empty until the paper workflow and authorization gates have been verified. Keep `AI_ENDPOINT_ALLOWLIST` empty in production unless an operator deliberately authorizes an exact trusted model origin. File-based Compose environment configuration is a baseline; restrict `.env` permissions and replace it with your platform secret delivery in a managed deployment.

## Windows local runtime

The optional PowerShell helper uses project-local state under ignored `.runtime`: PostgreSQL data, generated database password, Redis persistence and process logs. It binds PostgreSQL to loopback port 5433 and Redis to loopback port 6380. It does not change the shared Laragon services. `PG_BIN` defaults to `C:/laragon/bin/postgresql/getfile/bin`; set this process environment variable if your PostgreSQL executable directory differs. The helper expects its own generated `.runtime/pg-password`; for an independently configured existing database use your service management and `.env` connection instead.

The local Redis default is `.runtime/redis-8.8.3/Redis-8.8.3-Windows-x64-cygwin`. This Windows port comes from the [redis-windows maintainer's 8.8.3 release](https://github.com/redis-windows/redis-windows/releases/tag/8.8.3), separately from the Linux Redis image used in Compose. The downloaded [Windows x64 Cygwin archive](https://github.com/redis-windows/redis-windows/releases/download/8.8.3/Redis-8.8.3-Windows-x64-cygwin.zip) was verified locally on 2026-10-04 with SHA-256 `BB19F830CA5BF62718E81F230833F968B90ECFD675557CAF3C1478C4E65BD98C`. Keep the Laragon Redis 8.8.0 installation untouched: its `LREM key -1 value` behavior failed the local queue compatibility check, while this isolated 8.8.3 runtime passed the same check and worker queue processing. A version label alone is not that compatibility evidence.

To provision the same isolated runtime, run from the project directory:

```powershell
New-Item -ItemType Directory -Force .runtime | Out-Null
Invoke-WebRequest -Uri 'https://github.com/redis-windows/redis-windows/releases/download/8.8.3/Redis-8.8.3-Windows-x64-cygwin.zip' -OutFile .runtime/redis-8.8.3.zip
if ((Get-FileHash .runtime/redis-8.8.3.zip -Algorithm SHA256).Hash -ne 'BB19F830CA5BF62718E81F230833F968B90ECFD675557CAF3C1478C4E65BD98C') { throw 'Redis archive checksum mismatch' }
Expand-Archive -LiteralPath .runtime/redis-8.8.3.zip -DestinationPath .runtime/redis-8.8.3
pwsh -File scripts/local-services.ps1
pnpm db:migrate
pnpm owner:create
pnpm dev
```

Download/extraction is a first-time step; if the verified archive/runtime already exists, start from the helper command. The helper creates `.env` with fresh local auth/encryption keys only when absent, initializes its PostgreSQL cluster only when absent, and checks `pg_isready` before querying/creating the database. PostgreSQL readiness is bounded to 30 seconds, with an early failure if the process exits. Database lookup/creation failures stop startup. Redis must return `PONG` before success is reported. Existing project PostgreSQL is reused through `pg_ctl status`; an occupied port belonging to another process stops startup instead of killing it.

After application startup, `Invoke-RestMethod http://127.0.0.1:4100/api/health` checks the API's database and Redis connectivity. Run `pnpm exec tsx --env-file=.env scripts/worker-health.ts` to check both the independent worker heartbeat (20-second freshness) and operations queue heartbeat (45-second freshness) from the same worker PID. Compose wires this script into the worker healthcheck with a 20-second start period. A fresh API alone cannot prove queue processing.

This is local Windows operation. Compose configuration/build artifacts and these commands do not establish an available Docker daemon or a deployed VPS.

## First deployment

1. Point DNS at the host and expose ports 80/443 to Caddy. PostgreSQL and Redis have no published host ports.
2. Run `docker compose build`. The Node 24 image installs the lockfile with frozen resolution, builds web/API/worker and runs as the unprivileged node user. Build must succeed before continuing.
3. Run `docker compose up -d postgres redis` and wait for healthy dependencies.
4. Provision a dedicated non-superuser role before migration: open `docker compose exec postgres psql -U postgres -d postgres`, run `CREATE ROLE polymarket LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`, set its password with interactive `\password polymarket`, and run `ALTER DATABASE polymarket OWNER TO polymarket;`. Set `DATABASE_URL` with that role and password. Then run `docker compose run --rm api pnpm exec tsx scripts/migrate.ts`. For stricter operation, use a separate migration owner and grant the runtime role only required table/sequence permissions after migrations.
5. Create the owner using `docker compose run --rm api pnpm exec tsx scripts/create-owner.ts` and its documented owner initialization flow.
6. Run `docker compose up -d api worker caddy`. Check service status, HTTPS health and the authenticated owner UI. API health checks use `/api/health` to check PostgreSQL and Redis; worker health checks additionally require fresh worker and operations queue heartbeats with matching PID. Healthy services alone do not establish successful paid-provider or trading behavior.
7. Verify live mode is off, paper workflow, provider secret redaction, invocation budget reservation, kill switch, queue processing and journal balances. Configure real providers only when authorized.

API and worker restart independently. PostgreSQL 18 persists at `/var/lib/postgresql` (its versioned data directory is inside that volume), Redis 8 uses append-only persistence, and Caddy retains ACME state in named volumes. The runtime currently retains installed development tools to support migration/owner CLIs; stripping them requires a separate operational image. The worker does not require the browser UI to remain open.

## Encrypted backups

For a VPS already running Nginx, use the [existing proxy runbook](vps.md) and `compose.vps.yaml`. This adds a PostgreSQL 18 backup image, keeps Caddy behind an opt-in profile, and publishes the API only on loopback. Do not enable the Caddy profile on a host where Nginx already owns ports 80/443.

Install PostgreSQL 18 clients on the backup host and make `pg_dump` / `pg_restore` available. On Windows set `PG_BIN` to the executable directory. Run the scripts using the installed project runtime: `pnpm exec tsx --env-file=.env scripts/backup.ts /secure/backups/polymarket-2026-10-04.pmbk`. `DATABASE_URL` selects the source and `BACKUP_KEY` encrypts it. Existing backup files are never overwritten. Metadata is authenticated as AES-256-GCM additional data; the custom-format dump streams directly into encryption. The archive contains a format marker, bounded authenticated metadata, random 96-bit nonce, ciphertext and 128-bit authentication tag. Plain database dumps are never written during backup. PostgreSQL subprocess arguments omit credentials and subprocess diagnostics are suppressed.

API and worker writers can keep running during backup. The script opens one repeatable-read read-only transaction, exports its PostgreSQL snapshot and reads table counts plus journal balances from that same transaction. `pg_dump --snapshot` imports the snapshot while its exporting transaction remains open; the dump and authenticated manifest therefore describe one committed database state despite concurrent writes. The snapshot transaction commits only after the encrypted dump completes. Failed validation discards the partial encrypted file. PostgreSQL commands time out after 15 minutes; database metadata queries have connection and statement deadlines. Keep backups on an authorized client host/container on the Compose network; PostgreSQL is not exposed by default and must not be published publicly for backups.

Schedule this procedure daily with the host's systemd timer or controlled task scheduler, record only exit status and artifact path, alert on failure, and copy successful encrypted archives to a separate storage location. Keep retention according to your operational needs; deletion is an explicit operator policy. This backup covers PostgreSQL application data, including encrypted provider secrets and ledgers. Redis queue/AOF and configuration need their own recovery plan. Preserve provider `MASTER_KEY`, auth configuration and backup keys independently.

## Restore drill and recovery

1. Create a new empty isolated PostgreSQL database, for example `polymarket_restore_20261004`. Never point restore at the production database. Use a dedicated database owner and prevent application connections to that target.
2. Set `RESTORE_DATABASE_URL` to that target and supply the matching `BACKUP_KEY`. Keep `DATABASE_URL` set to production/source so the script can additionally reject a matching host/port/database target.
3. Run `pnpm exec tsx --env-file=.env scripts/restore.ts /secure/backups/polymarket-2026-10-04.pmbk --confirm-isolated-target`.
4. The script verifies GCM authentication before database mutation, requires an empty target, restores in one PostgreSQL transaction, compares all public table counts, and checks that every journal has at least two entries summing exactly to zero. Authentication uses a temporary plaintext dump with restricted file permissions; it is deleted in a finally block. Use encrypted local disks for restore staging.
5. A successful script confirms database integrity and counts, not business UAT. Launch an isolated application with live execution off and matching `MASTER_KEY`, check owner access, providers, paper state, ledger and reports. Verify queue behavior separately. Decide explicitly whether to promote the recovered database after these checks.

A wrong key, truncated/modified archive, missing PostgreSQL client, nonempty target, source-target collision or unbalanced journal fails with a generic safe diagnostic. Do not log connection URLs, keys, decrypted dumps or provider errors. Rehearse restoration regularly; an untested backup is not an established recovery procedure.

Deployment references: [official PostgreSQL image and PostgreSQL 18 volume layout](https://hub.docker.com/_/postgres), [Compose dependency health ordering](https://docs.docker.com/compose/how-tos/startup-order/), and [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Local drill evidence: see [financial verification](financial-verification.md) for the actual encrypted archive restore on 2026-10-04, isolated target name, financial scenarios and remaining verification boundaries. This local drill does not establish production recovery or Redis recovery.
