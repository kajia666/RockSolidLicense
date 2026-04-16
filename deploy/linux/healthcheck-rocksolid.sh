#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TCP_HOST="${TCP_HOST:-127.0.0.1}"
TCP_PORT="${TCP_PORT:-4000}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-10}"
SKIP_TCP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --tcp-host)
      TCP_HOST="$2"
      shift 2
      ;;
    --tcp-port)
      TCP_PORT="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --skip-tcp)
      SKIP_TCP=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

HEALTH_URL="${BASE_URL%/}/api/health"
HTTP_BODY="$(curl --silent --show-error --fail --max-time "$TIMEOUT_SECONDS" "$HEALTH_URL")"

if ! printf '%s' "$HTTP_BODY" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo "Health endpoint did not report status=ok" >&2
  exit 1
fi

TCP_OK=true
if [[ "$SKIP_TCP" -eq 0 ]]; then
  if command -v nc >/dev/null 2>&1; then
    nc -z -w "$TIMEOUT_SECONDS" "$TCP_HOST" "$TCP_PORT"
  else
    timeout "$TIMEOUT_SECONDS" bash -c "cat < /dev/null > /dev/tcp/$TCP_HOST/$TCP_PORT"
  fi
fi

cat <<EOF
{
  "checkedAt": "$(date --iso-8601=seconds)",
  "http": {
    "url": "$HEALTH_URL",
    "ok": true
  },
  "tcp": {
    "checked": $([[ "$SKIP_TCP" -eq 0 ]] && echo true || echo false),
    "host": "$TCP_HOST",
    "port": $TCP_PORT,
    "ok": $TCP_OK
  }
}
EOF
