#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/opt/rocksolidlicense}"
ENV_FILE="${ENV_FILE:-/etc/rocksolidlicense/rocksolid.env}"
LOG_DIR="${LOG_DIR:-/var/log/rocksolid}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
APP_ENTRY="${APP_ENTRY:-$PROJECT_ROOT/src/server.js}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

DATA_DIR="${RSL_DATA_DIR:-$PROJECT_ROOT/data}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/rocksolid-server.log}"

mkdir -p "$DATA_DIR" "$LOG_DIR"
touch "$LOG_FILE"

cd "$PROJECT_ROOT"
exec "$NODE_BIN" "$APP_ENTRY" >>"$LOG_FILE" 2>&1
