#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/rocksolidlicense/rocksolid.env}"
BACKUP_FILE="${BACKUP_FILE:-}"
PSQL_BIN="${PSQL_BIN:-psql}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
NO_CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      BACKUP_FILE="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --no-clean)
      NO_CLEAN=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: restore-postgres.sh --file /path/to/backup.dump [--no-clean]" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file was not found: $BACKUP_FILE" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
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

case "$BACKUP_FILE" in
  *.dump)
    if ! command -v "$PG_RESTORE_BIN" >/dev/null 2>&1; then
      echo "pg_restore was not found. Install PostgreSQL client tools or set PG_RESTORE_BIN." >&2
      exit 1
    fi

    restore_args=(--no-owner --dbname "$PGDATABASE")
    if [[ "$NO_CLEAN" -eq 0 ]]; then
      restore_args=(--clean --if-exists "${restore_args[@]}")
    fi

    "$PG_RESTORE_BIN" "${restore_args[@]}" "$BACKUP_FILE"
    ;;
  *.sql)
    if ! command -v "$PSQL_BIN" >/dev/null 2>&1; then
      echo "psql was not found. Install PostgreSQL client tools or set PSQL_BIN." >&2
      exit 1
    fi

    "$PSQL_BIN" -v ON_ERROR_STOP=1 -d "$PGDATABASE" -f "$BACKUP_FILE"
    ;;
  *.sql.gz)
    if ! command -v "$PSQL_BIN" >/dev/null 2>&1; then
      echo "psql was not found. Install PostgreSQL client tools or set PSQL_BIN." >&2
      exit 1
    fi

    gzip -dc "$BACKUP_FILE" | "$PSQL_BIN" -v ON_ERROR_STOP=1 -d "$PGDATABASE"
    ;;
  *)
    echo "Unsupported backup file format: $BACKUP_FILE" >&2
    exit 1
    ;;
esac

echo "PostgreSQL restore completed from $BACKUP_FILE"
