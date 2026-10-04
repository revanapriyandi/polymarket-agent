FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=2
COPY . .
RUN NODE_OPTIONS=--max-old-space-size=512 pnpm build
RUN test -f dist/server/api/src/index.js && test -f dist/server/worker/src/index.js && test -f scripts/worker-health.ts
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4100
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4100
CMD ["node", "dist/server/api/src/index.js"]

# Matching PostgreSQL 18 tools for encrypted backup and isolated restore jobs.
FROM postgres:18-bookworm AS backup
WORKDIR /app
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=postgres:postgres /app /app
USER postgres
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["scripts/backup.ts"]

FROM runtime AS app
