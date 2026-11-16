#!/bin/sh
# Internet exit through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).
#
# Runs Tailscale and keeps the exit node in line with the PC. Everything in this
# container's network namespace — the edge Waxum shares it — goes out through
# the PC while it is online. When the PC stops answering:
#   EGRESS_FALLBACK=offline  the exit node stays set and Tailscale drops the
#                            traffic: the lines go offline until the PC is back;
#   EGRESS_FALLBACK=vps      the exit node is cleared and the traffic goes out
#                            through the VPS until the PC is back.
# The healthcheck stays red until the first route is chosen, so the edge Waxum
# never starts going out through the VPS by accident.
set -eu

: "${EGRESS_EXIT_NODE:?EGRESS_EXIT_NODE: Tailscale IP of the attendant PC}"
case "${EGRESS_FALLBACK:-}" in
  offline|vps) ;;
  *) echo "EGRESS_FALLBACK precisa ser offline ou vps" >&2; exit 1 ;;
esac

ROUTE_FILE=/tmp/egress-route
CHECK_SECONDS=10
# Three missed pings in a row (~30 s) before giving up on the PC, so a short
# Wi-Fi hiccup does not flip the line between two IPs.
MISSES_BEFORE_FALLBACK=3

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') egress: $*"; }

rm -f "$ROUTE_FILE"
/usr/local/bin/containerboot &
boot=$!
trap 'kill -TERM "$boot" 2>/dev/null; wait "$boot"; exit 0' TERM INT

until tailscale status >/dev/null 2>&1; do
  kill -0 "$boot" 2>/dev/null || exit 1
  sleep 2
done

route=""
misses=0
while kill -0 "$boot" 2>/dev/null; do
  if tailscale ping -c 1 --timeout 3s "$EGRESS_EXIT_NODE" >/dev/null 2>&1; then
    misses=0
    if [ "$route" != pc ] && tailscale set --exit-node="$EGRESS_EXIT_NODE" --exit-node-allow-lan-access=true; then
      route=pc
      log "saindo pelo PC $EGRESS_EXIT_NODE"
    fi
  else
    misses=$((misses + 1))
    if [ "$misses" -ge "$MISSES_BEFORE_FALLBACK" ] && [ "$route" != "$EGRESS_FALLBACK" ]; then
      if [ "$EGRESS_FALLBACK" = vps ]; then
        tailscale set --exit-node= && route=vps && log "PC $EGRESS_EXIT_NODE sem resposta: saindo pela VPS"
      elif tailscale set --exit-node="$EGRESS_EXIT_NODE" --exit-node-allow-lan-access=true; then
        route=offline
        log "PC $EGRESS_EXIT_NODE sem resposta: números sem internet até ele voltar"
      fi
    fi
  fi
  [ -n "$route" ] && printf '%s\n' "$route" > "$ROUTE_FILE"
  sleep "$CHECK_SECONDS"
done
wait "$boot"
