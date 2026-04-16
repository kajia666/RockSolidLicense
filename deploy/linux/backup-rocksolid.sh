#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/opt/rocksolidlicense}"
ENV_FILE="${ENV_FILE:-/etc/rocksolidlicense/rocksolid.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/rocksolid/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LABEL="${LABEL:-manual}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

DATA_DIR="${RSL_DATA_DIR:-/var/lib/rocksolid/data}"
DB_PATH="${RSL_DB_PATH:-$DATA_DIR/rocksolid.db}"
PRIVATE_KEY_PATH="${RSL_LICENSE_PRIVATE_KEY_PATH:-$DATA_DIR/license_private.pem}"
PUBLIC_KEY_PATH="${RSL_LICENSE_PUBLIC_KEY_PATH:-$DATA_DIR/license_public.pem}"
KEYRING_PATH="${RSL_LICENSE_KEYRING_PATH:-$DATA_DIR/license_keyring.json}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="rocksolid-backup-$TIMESTAMP-$LABEL.tar.gz"
ARCHIVE_PATH="$BACKUP_DIR/$ARCHIVE_NAME"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rocksolid-backup-XXXXXX")"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

declare -a COPIED_FILES=()

copy_if_exists() {
  local source_path="$1"
  local target_path="$2"
  if [[ ! -f "$source_path" ]]; then
    return
  fi

  mkdir -p "$(dirname "$STAGING_DIR/$target_path")"
  cp "$source_path" "$STAGING_DIR/$target_path"
  COPIED_FILES+=("$target_path")
}

copy_if_exists "$DB_PATH" "data/rocksolid.db"
copy_if_exists "$PRIVATE_KEY_PATH" "data/license_private.pem"
copy_if_exists "$PUBLIC_KEY_PATH" "data/license_public.pem"
copy_if_exists "$KEYRING_PATH" "data/license_keyring.json"
copy_if_exists "$ENV_FILE" "config/rocksolid.env"

if [[ "${#COPIED_FILES[@]}" -eq 0 ]]; then
  echo "No backup files were found. Check your env paths before retrying." >&2
  exit 1
fi

{
  echo "createdAt=$(date --iso-8601=seconds)"
  echo "projectRoot=$PROJECT_ROOT"
  echo "envFile=$ENV_FILE"
  echo "label=$LABEL"
  echo "mainStoreDriver=${RSL_MAIN_STORE_DRIVER:-sqlite}"
  echo "stateStoreDriver=${RSL_STATE_STORE_DRIVER:-sqlite}"
  printf 'copiedFiles=%s\n' "$(IFS=,; echo "${COPIED_FILES[*]}")"
} > "$STAGING_DIR/manifest.txt"

tar -C "$STAGING_DIR" -czf "$ARCHIVE_PATH" .

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rocksolid-backup-*.tar.gz' -mtime +"$RETENTION_DAYS" -delete

echo "Backup created at $ARCHIVE_PATH"
