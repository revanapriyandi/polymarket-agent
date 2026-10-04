#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: backup.sh ABSOLUTE_PROJECT_DIRECTORY\n' >&2
  exit 2
fi
project_directory=$(realpath -e -- "$1")
cd "$project_directory"
[[ -f compose.vps.yaml && -f .env ]] || { printf 'Compose project or private environment missing.\n' >&2; exit 1; }
# Use the same project name and environment as the running services.
backup_name="polymarket-$(date -u +%Y%m%dT%H%M%SZ).pmbk"
docker compose -p polymarket-agent -f compose.yaml -f compose.vps.yaml run --rm --no-deps -T backup scripts/backup.ts "/backups/$backup_name"
printf 'Encrypted backup completed: %s\n' "$backup_name"
