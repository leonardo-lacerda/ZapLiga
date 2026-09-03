#!/bin/sh
set -u

FAILURE_FILE=/tmp/waxum-nats-health-failures
WAXUM_HEALTH_URL="${WAXUM_HEALTH_URL:-http://127.0.0.1:3451/livez}"
NATS_CONNECTIONS_URL="${NATS_CONNECTIONS_URL:-http://nats:8222/connz}"

if curl -fsS --max-time 4 "$WAXUM_HEALTH_URL" >/dev/null \
  && curl -fsS --max-time 4 "$NATS_CONNECTIONS_URL" \
    | grep -Eq '"lang"[[:space:]]*:[[:space:]]*"rust"'; then
  rm -f "$FAILURE_FILE"
  exit 0
fi

failures=0
if [ -f "$FAILURE_FILE" ]; then
  failures=$(cat "$FAILURE_FILE" 2>/dev/null || printf '0')
fi
case "$failures" in (*[!0-9]*|'') failures=0 ;; esac
failures=$((failures + 1))
printf '%s\n' "$failures" > "$FAILURE_FILE"
echo "Integração Waxum/NATS indisponível ($failures/3)" >&2

if [ "$failures" -ge 3 ]; then
  echo "Encerrando Waxum para reconexão automática" >&2
  rm -f "$FAILURE_FILE"
  kill -TERM 1
fi
exit 1
