#!/bin/sh
set -eu

NATS_HEALTH_URL="${NATS_HEALTH_URL:-http://nats:8222/healthz}"
echo "Aguardando NATS antes de iniciar o Waxum..."
until curl -fsS --max-time 4 "$NATS_HEALTH_URL" >/dev/null; do
  sleep 2
done

# Waxum must own PID 1 because its session lock records and validates that PID.
# exec preserves that invariant while still preventing the startup race.
exec /app/docker-entrypoint.sh "$@"
