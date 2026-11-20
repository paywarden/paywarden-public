#!/usr/bin/env bash
# ============================================================================
# PayWarden — PostgreSQL backup script
# ============================================================================
# Dumps the paywarden database to a timestamped gzip file and prunes files
# older than 7 days. Intended to run via cron on the host.
#
# IMPORTANT: this backs up ONLY PostgreSQL. For a complete disaster recovery
# you MUST also back up:
#   - vault/             — encrypted HD wallet seed (without this, the DB
#                          addresses cannot be swept or regenerated)
#   - .env.production    — holds VAULT_KEY, without which vault/ is unreadable
#
# Redis is not backed up because it only holds transient queue state;
# AOF persistence in docker-compose.prod.yml provides sufficient durability.
#
# Crontab example (daily at 03:00 UTC):
#   0 3 * * * /opt/paywarden/scripts/backup-pg.sh >> /var/log/paywarden-backup.log 2>&1
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${REPO_DIR}/backups"
RETENTION_DAYS=7
COMPOSE_FILE="${REPO_DIR}/docker-compose.prod.yml"
ENV_FILE="${REPO_DIR}/.env.production"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="paywarden_${TIMESTAMP}.sql.gz"
DEST="${BACKUP_DIR}/${FILENAME}"

echo "[$(date -Iseconds)] Starting backup → ${FILENAME}"

# Load POSTGRES_USER/POSTGRES_DB from env file
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  | gzip > "$DEST"

SIZE=$(du -h "$DEST" | cut -f1)
echo "[$(date -Iseconds)] Backup created: ${FILENAME} (${SIZE})"

# Prune old backups
find "$BACKUP_DIR" -name 'paywarden_*.sql.gz' -type f -mtime +${RETENTION_DAYS} -print -delete

echo "[$(date -Iseconds)] Backup complete. Older-than-${RETENTION_DAYS}-days pruned."
