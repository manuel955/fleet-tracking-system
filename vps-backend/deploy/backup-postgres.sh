#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/apl-fleet-vps
BACKUP_DIR=/var/backups/apl-fleet-vps
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/apl_logistics_$STAMP.sql.gz"

install -d -m 700 "$BACKUP_DIR"
cd "$ROOT"
docker compose --env-file "$ROOT/.env" -f "$ROOT/docker-compose.yml" \
  exec -T postgres pg_dump -U apl -d apl_logistics --no-owner --no-privileges \
  | gzip -9 > "$FILE"
test -s "$FILE"
chmod 600 "$FILE"
# Keep two weeks of daily snapshots. This directory is dedicated to this
# service; no POS data or POS volumes are touched.
find "$BACKUP_DIR" -type f -name 'apl_logistics_*.sql.gz' -mtime +14 -delete
echo "Created $FILE"
