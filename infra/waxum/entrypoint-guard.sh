#!/bin/sh
set -eu

NATS_HEALTH_URL="${NATS_HEALTH_URL:-http://nats:8222/healthz}"
NATS_CONNECTIONS_URL="${NATS_CONNECTIONS_URL:-http://nats:8222/connz}"
WAXUM_HEALTH_URL="${WAXUM_HEALTH_URL:-http://127.0.0.1:3451/livez}"
READY_FILE=/tmp/waxum-nats-ready
WAXUM_PID=

cleanup() {
  rm -f "$READY_FILE"
  if [ -n "$WAXUM_PID" ] && kill -0 "$WAXUM_PID" 2>/dev/null; then
    kill -TERM "$WAXUM_PID" 2>/dev/null || true
    wait "$WAXUM_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

rm -f "$READY_FILE"
echo "Aguardando NATS antes de iniciar o Waxum..."
until wget -q -T 4 -O /dev/null "$NATS_HEALTH_URL"; do
  sleep 2
done

# Preserve the image's original entrypoint because it prepares permissions and
# then execs the Waxum binary. Running it as a child lets this guard terminate
# the process when the NATS integration becomes unhealthy; Docker's
# `restart: unless-stopped` then starts a clean process and reconnects it.
/app/docker-entrypoint.sh "$@" &
WAXUM_PID=$!

nats_has_waxum() {
  wget -q -T 4 -O - "$NATS_CONNECTIONS_URL" | grep -Eq '"lang"[[:space:]]*:[[:space:]]*"rust"'
}

ready=false
attempt=1
while [ "$attempt" -le 45 ]; do
  if ! kill -0 "$WAXUM_PID" 2>/dev/null; then
    wait "$WAXUM_PID"
    exit $?
  fi
  if curl -fsS --max-time 4 "$WAXUM_HEALTH_URL" >/dev/null && nats_has_waxum; then
    touch "$READY_FILE"
    ready=true
    echo "Waxum pronto e conectado ao NATS"
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if [ "$ready" != true ]; then
  echo "Waxum iniciou sem confirmar conexão com NATS; reiniciando container" >&2
  cleanup
  exit 1
fi

failures=0
while kill -0 "$WAXUM_PID" 2>/dev/null; do
  sleep 15
  if curl -fsS --max-time 4 "$WAXUM_HEALTH_URL" >/dev/null && nats_has_waxum; then
    failures=0
    touch "$READY_FILE"
    continue
  fi

  failures=$((failures + 1))
  rm -f "$READY_FILE"
  echo "Integração Waxum/NATS indisponível ($failures/3)" >&2
  if [ "$failures" -ge 3 ]; then
    echo "Reiniciando Waxum para restaurar a integração com NATS" >&2
    cleanup
    exit 1
  fi
done

wait "$WAXUM_PID"
