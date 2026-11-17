#!/bin/sh
set -u

FAILURE_FILE=/tmp/waxum-nats-health-failures
WAXUM_HEALTH_URL="${WAXUM_HEALTH_URL:-http://127.0.0.1:3451/livez}"
NATS_CONNECTIONS_URL="${NATS_CONNECTIONS_URL:-http://nats:8222/connz}"

# Address this container uses for its NATS connection (port 4222 = 0x107E,
# state 01 = established), read from /proc/net/tcp in little-endian hex.
own_nats_ip() {
  hex=$(awk '$3 ~ /:107E$/ && $4 == "01" { print substr($2, 1, 8); exit }' /proc/net/tcp)
  [ -n "$hex" ] || return 1
  printf '%d.%d.%d.%d' "0x$(echo "$hex" | cut -c7-8)" "0x$(echo "$hex" | cut -c5-6)" "0x$(echo "$hex" | cut -c3-4)" "0x$(echo "$hex" | cut -c1-2)"
}

# Several Waxums share NATS (the main one and one per attendant PC), so the
# Rust client NATS lists must be this container's own connection.
nats_has_own_rust_client() {
  ip=$(own_nats_ip) || return 1
  curl -fsS --max-time 4 "$NATS_CONNECTIONS_URL" \
    | awk -v ip="\"$ip\"" '/"ip":/ { mine = index($0, ip) > 0 } /"lang":/ && mine && /"rust"/ { found = 1 } END { exit !found }'
}

# A PC slot whose Waxum is still waiting for a PC (infra/egress/waxum-edge-guard.sh)
# is idle on purpose: nothing to check, and nothing to restart.
if [ -n "${EGRESS_ROUTE_FILE:-}" ] && ! grep -qxE 'pc|offline|vps' "$EGRESS_ROUTE_FILE" 2>/dev/null; then
  exit 0
fi

if curl -fsS --max-time 4 "$WAXUM_HEALTH_URL" >/dev/null && nats_has_own_rust_client; then
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
