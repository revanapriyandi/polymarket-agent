# Deploy behind an existing Nginx server

Use `compose.yaml` with `compose.vps.yaml`, project name `polymarket-agent`. The override binds the API to `127.0.0.1:4105`, limits service CPU/memory and log size, and keeps PostgreSQL/Redis inside the Compose network. Caddy is opt-in through `standalone-tls`; do not enable it when the host already owns ports 80/443. The worker continues independently of the browser.

## Layout and private configuration

Recommended layout: `/opt/polymarket-agent/app` for the Git checkout, `/opt/polymarket-agent/runtime` for root-only configuration, and `/opt/polymarket-agent/backups` for encrypted database archives. Symlink `app/.env` to `../runtime/production.env`. Keep the runtime directory mode 700 and the environment mode 600. The build excludes environments, `.runtime`, local dependency caches, browser artifacts, keys and backup files.

Configure the values in `.env.example` according to [deployment.md](deployment.md). Also set `APP_VERSION` to the deployed Git commit, `APP_LOCAL_PORT=4105`, and `BACKUP_DIRECTORY=/opt/polymarket-agent/backups`. Use independent PostgreSQL administrator, application, auth, encryption and backup credentials. Never paste their values into Git or deployment command arguments. Keep `ENABLE_LIVE_EXECUTION=false`.

## Initial release

1. Inspect available RAM/disk, existing containers, port 4105 and the target directory. Leave unrelated applications unchanged. Review DNS/proxy routing for the chosen hostname.
2. Install the private environment. Run `docker compose -p polymarket-agent -f compose.yaml -f compose.vps.yaml config --quiet` to validate without printing resolved secrets.
3. Verify the exact release checkout with `pnpm build` (including TypeScript) and `pnpm lint` locally or in CI first. Build the application image with `docker compose -p polymarket-agent -f compose.yaml -f compose.vps.yaml build api`, then build `backup` separately. One application image is shared by API and worker. Docker runs `build:bundle` with a 512 MB Node heap; it does not repeat the more memory-intensive TypeScript check on the shared VPS. Native memory and dependency installation consume additional RAM.
4. Start `postgres redis`, provision a dedicated non-superuser database owner, then run `docker compose -p polymarket-agent -f compose.yaml -f compose.vps.yaml run --rm --no-deps api pnpm exec tsx scripts/migrate.ts`.
5. Create the owner using `scripts/create-owner.ts`. Supply the initial password through a private process environment, not shell history. The CLI refuses to replace an existing owner.
6. Start `api worker --no-build`. Wait for dependency, API and worker health checks. Confirm the image version and `ENABLE_LIVE_EXECUTION=false` without printing the environment.
7. Add a dedicated Nginx virtual host. Use [the Nginx example](../scripts/deploy/nginx.conf.example), first exposing only its ACME webroot over HTTP. Verify a unique challenge file through public DNS before requesting a certificate. Install valid TLS, run `nginx -t`, then reload gracefully. If Cloudflare is used, configure Full (strict) TLS and avoid caching authenticated routes or SSE.
8. Verify public HTTPS, static assets, unauthenticated API denial, owner login, sensitive-action reauthentication, Settings help and SSE snapshots. Resume PAPER only after controls and risk settings are reviewed. Actual provider keys, wallet readiness, paper evaluation and real trading remain separate gates.

## Daily backup and restore

The `backup` image uses the matching PostgreSQL 18 clients plus the application's Node runtime. It runs as the image's `postgres` user. Set the backup directory owner to that image's UID/GID and mode 700. Verify these IDs from the built image; do not assume a host account with the same name is equivalent.

Run `bash scripts/deploy/backup.sh /opt/polymarket-agent/app`. The helper runs an isolated maintenance container using only `DATABASE_URL` and `BACKUP_KEY`, streams an encrypted backup into the mounted directory, and fails rather than overwriting an existing archive. It never deletes old backups. Schedule this exact command with a dedicated systemd oneshot service/timer and inspect its exit status. Copy encrypted archives to an independent destination when configured, keeping recovery keys separately.

To rehearse restore, provision a **new empty database**, inject its URL as `RESTORE_DATABASE_URL`, and run the backup image with `scripts/restore.ts /backups/ARCHIVE.pmbk --confirm-isolated-target`. `DATABASE_URL` must continue to identify the original source. The script rejects that source as a target, verifies authentication before writing, compares table counts, and checks balanced journals. Do not direct the application or worker at the drill database.

## Updates and rollback

Record the running Git SHA/image tag and take a verified encrypted database backup before changing a deployed version. Fetch the intended commit without discarding local configuration. Build a new tagged image, run compatible migrations, then replace API/worker. Verify public health, authentication, SSE, queue heartbeat and accounting. Keep the previous tagged image available for rollback; do not delete volumes or run `down --volumes`. A code rollback must remain compatible with the migrated schema. Restoring data requires an explicit recovery decision and reconciliation of operations since the backup.

These are operational instructions. Actual release, certificate and restore evidence is recorded separately in the release verification report.
