#!/usr/bin/env bash
# Rebuild the real π-Lab baseline after a verified local-stack backup.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILES=(-f "$ROOT/docker-compose-local.yml" -f "$ROOT/docker-compose-local.override.yml")
MODE=""
BACKUP_ROOT="${PLANE_BACKUP_ROOT:-$ROOT/.runtime/backups}"
SERVICE_API="api"
SERVICE_WORKER="worker"
SERVICE_BEAT="beat-worker"

usage() {
  cat <<'EOF'
Usage: scripts/rebuild-pi-lab-baseline.sh --dry-run|--verify-only|--yes [--backup-root DIR]

Modes:
  --dry-run     validate the locked source workbooks and print the rebuild plan
  --verify-only validate the current database against the π-Lab baseline
  --yes         back up, drill restore, stop writes, rebuild, and restart services

The backup and credential manifests are written outside Git. --yes always
requires a fresh timestamped backup directory.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--verify-only|--yes)
      [[ -z "$MODE" ]] || { echo "mode may only be specified once" >&2; usage; exit 2; }
      MODE="$1"
      shift
      ;;
    --backup-root)
      [[ $# -ge 2 ]] || { echo "--backup-root requires a directory" >&2; exit 2; }
      BACKUP_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done
[[ -n "$MODE" ]] || { usage; exit 2; }

STUDENTS="$ROOT/refer/π-Lab学生-导入信息表.xlsx"
ADVISORS="$ROOT/refer/导师信息表.xlsx"
EXPECTED_STUDENTS_SHA256="cda7489f256601179b587d7a5bb7035145854272325e1599c62723f0cf0ecaa0"
EXPECTED_ADVISORS_SHA256="ac21aba18ebc147a5b6d5c50ab6f4acdf595aec2b0f3c37a1f0bbb18a8f6e548"
for pair in "$STUDENTS:$EXPECTED_STUDENTS_SHA256" "$ADVISORS:$EXPECTED_ADVISORS_SHA256"; do
  file="${pair%%:*}"
  expected="${pair##*:}"
  [[ -f "$file" ]] || { echo "missing source workbook: $file" >&2; exit 1; }
  actual="$(sha256sum "$file" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || { echo "source workbook hash mismatch: $file" >&2; exit 1; }
done

run_management() {
  local mode="$1"
  docker compose "${COMPOSE_FILES[@]}" run --rm \
    -v "$ROOT/refer:/refer:ro" \
    api python manage.py rebuild_pi_lab_baseline \
      --students /refer/π-Lab学生-导入信息表.xlsx \
      --advisors /refer/导师信息表.xlsx \
      "$mode"
}

if [[ "$MODE" == "--dry-run" ]]; then
  run_management --dry-run
  exit 0
fi
if [[ "$MODE" == "--verify-only" ]]; then
  run_management --verify
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_ROOT/pi-lab-$STAMP"
[[ ! -e "$OUT" ]] || { echo "backup destination already exists: $OUT" >&2; exit 1; }
mkdir -p "$OUT"

# Load only connection variables; never print them.
set -a
# shellcheck disable=SC1091
source "$ROOT/apps/api/.env"
set +a
POSTGRES_USER="${POSTGRES_USER:-plane}"
POSTGRES_DB="${POSTGRES_DB:-plane}"
DB_SERVICE_CID="$(docker compose "${COMPOSE_FILES[@]}" ps -q plane-db)"
[[ -n "$DB_SERVICE_CID" ]] || { echo "plane-db is not running" >&2; exit 1; }
MINIO_SERVICE_CID="$(docker compose "${COMPOSE_FILES[@]}" ps -q plane-minio)"
[[ -n "$MINIO_SERVICE_CID" ]] || { echo "plane-minio is not running" >&2; exit 1; }
DB_CONTAINER="$(docker inspect --format '{{.Name}}' "$DB_SERVICE_CID" | sed 's#^/##')"
COMPOSE_PROJECT="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$DB_SERVICE_CID")"
UPLOAD_VOLUME="${COMPOSE_PROJECT}_uploads"
docker volume inspect "$UPLOAD_VOLUME" >/dev/null

SERVICES_RESTARTED=0
restart_services() {
  if [[ "$SERVICES_RESTARTED" -eq 0 ]]; then
    docker compose "${COMPOSE_FILES[@]}" up -d "$SERVICE_API" "$SERVICE_WORKER" "$SERVICE_BEAT"
    SERVICES_RESTARTED=1
  fi
}
trap restart_services EXIT

echo "Stopping research writers..."
docker compose "${COMPOSE_FILES[@]}" stop "$SERVICE_API" "$SERVICE_WORKER" "$SERVICE_BEAT"

echo "Creating PostgreSQL backup..."
docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" --format=custom --file=/tmp/pi-lab-$STAMP.dump "$POSTGRES_DB"
docker cp "$DB_CONTAINER:/tmp/pi-lab-$STAMP.dump" "$OUT/database.dump"
docker exec "$DB_CONTAINER" rm -f "/tmp/pi-lab-$STAMP.dump"

echo "Creating MinIO uploads backup..."
docker run --rm \
  -v "$UPLOAD_VOLUME:/source:ro" \
  -v "$OUT:/backup" \
  postgres:15.7-alpine tar -czf /backup/uploads.tar.gz -C /source .
docker run --rm \
  -v "$UPLOAD_VOLUME:/source:ro" \
  -v "$OUT:/backup" \
  postgres:15.7-alpine sh -c 'cd /source && find . -type f -print0 | sort -z | xargs -0 sha256sum' \
  > "$OUT/uploads.sha256"
OBJECT_COUNT=$(( $(wc -l < "$OUT/uploads.sha256") + 0 ))

echo "Running PostgreSQL restore drill..."
DRILL_DB="plane_restore_drill_${STAMP}"
docker exec "$DB_CONTAINER" createdb -U "$POSTGRES_USER" "$DRILL_DB"
docker cp "$OUT/database.dump" "$DB_CONTAINER:/tmp/$DRILL_DB.dump"
docker exec "$DB_CONTAINER" pg_restore -U "$POSTGRES_USER" --no-owner --dbname="$DRILL_DB" "/tmp/$DRILL_DB.dump"
COUNT_SQL="$OUT/table-counts.sql"
docker exec "$DB_CONTAINER" psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT format('SELECT %L, count(*) FROM %I.%I;', table_schema || '.' || table_name, table_schema, table_name) FROM information_schema.tables WHERE table_schema='public' ORDER BY table_schema, table_name;" \
  > "$COUNT_SQL"
docker cp "$COUNT_SQL" "$DB_CONTAINER:/tmp/$DRILL_DB-counts.sql"
docker exec "$DB_CONTAINER" psql -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "/tmp/$DRILL_DB-counts.sql" > "$OUT/source-table-counts.tsv"
docker exec "$DB_CONTAINER" psql -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DRILL_DB" -f "/tmp/$DRILL_DB-counts.sql" > "$OUT/drill-table-counts.tsv"
cmp "$OUT/source-table-counts.tsv" "$OUT/drill-table-counts.tsv"
docker exec "$DB_CONTAINER" dropdb -U "$POSTGRES_USER" "$DRILL_DB"
docker exec "$DB_CONTAINER" rm -f "/tmp/$DRILL_DB.dump" "/tmp/$DRILL_DB-counts.sql"

echo "Running MinIO restore drill..."
mkdir -p "$OUT/restore-drill/uploads"
docker run --rm \
  -v "$OUT/uploads.tar.gz:/archive.tar.gz:ro" \
  -v "$OUT/restore-drill/uploads:/restore" \
  postgres:15.7-alpine tar -xzf /archive.tar.gz -C /restore
docker run --rm \
  -v "$OUT/restore-drill/uploads:/source:ro" \
  -v "$OUT:/backup" \
  postgres:15.7-alpine sh -c 'cd /source && find . -type f -print0 | sort -z | xargs -0 sha256sum' \
  > "$OUT/restore-drill/uploads.sha256"
cmp "$OUT/uploads.sha256" "$OUT/restore-drill/uploads.sha256"

DB_SHA256="$(sha256sum "$OUT/database.dump" | awk '{print $1}')"
OBJECTS_SHA256="$(sha256sum "$OUT/uploads.tar.gz" | awk '{print $1}')"
DB_SIZE="$(stat -c '%s' "$OUT/database.dump")"
OBJECTS_SIZE="$(stat -c '%s' "$OUT/uploads.tar.gz")"
python - "$OUT/manifest.json" "$STAMP" "$DB_SHA256" "$DB_SIZE" "$OBJECTS_SHA256" "$OBJECTS_SIZE" "$OBJECT_COUNT" <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    "schema_version": 1,
    "backup_id": sys.argv[2],
    "status": "VERIFIED",
    "created_at": sys.argv[2],
    "database": {"path": "database.dump", "sha256": sys.argv[3], "size": int(sys.argv[4])},
    "objects": {
        "path": "uploads.tar.gz",
        "sha256": sys.argv[5],
        "size": int(sys.argv[6]),
        "count": int(sys.argv[7]),
        "manifest_path": "uploads.sha256",
    },
    "restore_drill": {
        "status": "PASSED",
        "database_table_counts": "source-table-counts.tsv",
        "object_manifest": "restore-drill/uploads.sha256",
    },
    "source_files": {
        "students": {
            "path": "π-Lab学生-导入信息表.xlsx",
            "sha256": "cda7489f256601179b587d7a5bb7035145854272325e1599c62723f0cf0ecaa0",
            "rows": 190,
        },
        "advisors": {
            "path": "导师信息表.xlsx",
            "sha256": "ac21aba18ebc147a5b6d5c50ab6f4acdf595aec2b0f3c37a1f0bbb18a8f6e548",
            "rows": 15,
        },
    },
}
path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(path, 0o600)
PY
chmod 600 "$OUT/database.dump" "$OUT/uploads.tar.gz" "$OUT/uploads.sha256" "$OUT"/*-counts.tsv 2>/dev/null || true

echo "Rebuilding π-Lab baseline..."
docker compose "${COMPOSE_FILES[@]}" run --rm \
  -v "$ROOT/refer:/refer:ro" \
  -v "$OUT:/backup" \
  api python manage.py rebuild_pi_lab_baseline \
    --students /refer/π-Lab学生-导入信息表.xlsx \
    --advisors /refer/导师信息表.xlsx \
    --backup-manifest /backup/manifest.json \
    --credential-manifest /backup/credentials.json \
    --yes

echo "Baseline rebuild completed. Backup: $OUT"
restart_services
trap - EXIT
