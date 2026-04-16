#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/rocksolidlicense/rocksolid.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/rocksolid/postgres-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LABEL="${LABEL:-manual}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if ! command -v "$PG_DUMP_BIN" >/dev/null 2>&1; then
  echo "pg_dump was not found. Install PostgreSQL client tools or set PG_DUMP_BIN." >&2
  exit 1
fi

resolve_from_url_if_needed() {
  if [[ -n "${PGHOST:-}" && -n "${PGUSER:-}" && -n "${PGDATABASE:-}" ]]; then
    return
  fi

  if [[ -z "${RSL_POSTGRES_URL:-}" ]]; then
    return
  fi

  mapfile -t parsed < <(
    node -e '
      const value = process.argv[1];
      const url = new URL(value);
      const entries = [
        url.hostname || "",
        String(url.port || 5432),
        decodeURIComponent(url.username || ""),
        decodeURIComponent(url.password || ""),
        url.pathname.replace(/^\/+/, "")
      ];
      for (const item of entries) {
        console.log(item);
      }
    ' "$RSL_POSTGRES_URL"
  )

  export PGHOST="${PGHOST:-${parsed[0]}}"
  export PGPORT="${PGPORT:-${parsed[1]}}"
  export PGUSER="${PGUSER:-${parsed[2]}}"
  if [[ -n "${parsed[3]}" ]]; then
    export PGPASSWORD="${PGPASSWORD:-${parsed[3]}}"
  fi
  export PGDATABASE="${PGDATABASE:-${parsed[4]}}"
}

export PGHOST="${PGHOST:-${POSTGRES_HOST:-}}"
export PGPORT="${PGPORT:-${POSTGRES_PORT:-5432}}"
export PGUSER="${PGUSER:-${POSTGRES_USER:-}}"
if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
  export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD}}"
fi
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-}}"

resolve_from_url_if_needed

if [[ -z "${PGHOST:-}" || -z "${PGUSER:-}" || -z "${PGDATABASE:-}" ]]; then
  echo "PostgreSQL connection settings are incomplete. Set PGHOST/PGUSER/PGDATABASE or RSL_POSTGRES_URL." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_PATH="$BACKUP_DIR/rocksolid-postgres-backup-$TIMESTAMP-$LABEL.dump"
MANIFEST_PATH="$BACKUP_DIR/rocksolid-postgres-backup-$TIMESTAMP-$LABEL.manifest.txt"

"$PG_DUMP_BIN" \
  --format=custom \
  --no-owner \
  --file "$DUMP_PATH" \
  "$PGDATABASE"

{
  echo "createdAt=$(date --iso-8601=seconds)"
  echo "envFile=$ENV_FILE"
  echo "label=$LABEL"
  echo "host=$PGHOST"
  echo "port=$PGPORT"
  echo "database=$PGDATABASE"
  echo "user=$PGUSER"
  echo "mainStoreDriver=${RSL_MAIN_STORE_DRIVER:-}"
  echo "stateStoreDriver=${RSL_STATE_STORE_DRIVER:-}"
} > "$MANIFEST_PATH"

find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'rocksolid-postgres-backup-*.dump' -o -name 'rocksolid-postgres-backup-*.manifest.txt' \) \
  -mtime +"$RETENTION_DAYS" \
  -delete

echo "PostgreSQL backup created at $DUMP_PATH"
