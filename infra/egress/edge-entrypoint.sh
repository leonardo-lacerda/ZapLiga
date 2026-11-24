#!/bin/sh
# One PC slot: the Tailscale side (docs/saida-pelo-pc-do-atendente.md).
#
# Everything in this container's network namespace — the slot's Waxum shares it —
# goes out through the attendant's PC while it answers. Every 10 s the watcher
# asks the API which PC the slot serves (Admin → Saídas de internet), reports its
# route and keeps the exit node in line. When the PC stops answering, its
# fallback decides:
#   offline  the exit node stays set and Tailscale drops the traffic: the lines go
#            offline until the PC is back;
#   vps      the exit node is cleared and the traffic goes out through the VPS
#            until the PC is back.
# The route goes to /egress/route; the slot's Waxum only starts once it names
# a PC route (infra/egress/waxum-edge-guard.sh), so it never starts going out
# through the VPS by accident.
set -eu

: "${EGRESS_SLOT:?EGRESS_SLOT: name of the slot, e.g. edge-1}"
: "${WAXUM_API_KEY:?WAXUM_API_KEY: key shared with the API}"
API_URLS="${EGRESS_API_URLS:-http://api-a:3000 http://api-b:3000}"
ROUTE_FILE=/egress/route
CHECK_SECONDS=10
# Three missed checks in a row (~30 s) before giving up on the PC, so a short
# Wi-Fi hiccup does not flip the line between two IPs.
MISSES_BEFORE_FALLBACK=3
# A PC can answer Tailscale pings and still not pass internet as an exit node
# (exit node switched off, no internet on the PC). Each check also fetches this
# through the PC; while it fails the slot is not `pc`, so the API gives it no new lines.
PROBE_URL="${EGRESS_PROBE_URL:-http://connectivitycheck.gstatic.com/generate_204}"
# With the `vps` fallback the exit node is cleared, so the PC can only be tested
# by pointing the slot back at it: wait this long between such attempts.
INTERNET_RETRY_SECONDS=120

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') egress: $*"; }

mkdir -p /egress
rm -f "$ROUTE_FILE"
tailscaled --state=/var/lib/tailscale/tailscaled.state --tun=tailscale0 &
daemon=$!
trap 'kill -TERM "$daemon" 2>/dev/null; wait "$daemon"; exit 0' TERM INT

until tailscale status --json >/dev/null 2>&1; do
  kill -0 "$daemon" 2>/dev/null || exit 1
  sleep 1
done

logged_in() { tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; }

fetch_config() {
  for url in $API_URLS; do
    wget -qO- -T 5 --header "Authorization: Bearer $WAXUM_API_KEY" \
      "$url/api/internal/egress/slots/$EGRESS_SLOT?route=${route:-none}&loggedIn=$1" 2>/dev/null && return 0
  done
  return 1
}

value() { printf '%s\n' "$config" | sed -n "s/^$1=//p"; }

internet_through_pc() { wget -q -T 5 -O /dev/null "$PROBE_URL" 2>/dev/null; }

set_exit_node() {
  [ "$1" = "$current_exit" ] && return 0
  tailscale set --exit-node="$1" --exit-node-allow-lan-access="$([ -n "$1" ] && echo true || echo false)" || return 1
  current_exit=$1
}

route=""
misses=0
# Why the PC last failed a check: ping (no answer) or internet (answers, passes no traffic).
failure=ping
no_internet_at=0
# Unknown until the first `tailscale set`: forces it.
current_exit="unknown"
while kill -0 "$daemon" 2>/dev/null; do
  sleep_for=$CHECK_SECONDS
  if logged_in; then li=1; else li=0; fi
  # Without the API (a deploy, say) the slot keeps its current route.
  if config=$(fetch_config "$li"); then
    exit_node=$(value exit_node)
    fallback=$(value fallback)
    auth_key=$(value auth_key)

    if [ -z "$exit_node" ]; then
      # No PC on this slot (or it is not installed yet).
      if [ "$route" != idle ]; then
        { [ "$li" = 0 ] || set_exit_node ""; } && route=idle && misses=0 && log "nenhum PC nesta vaga"
      fi
    elif [ "$li" = 0 ]; then
      if [ -n "$auth_key" ] && tailscale up --auth-key="$auth_key" --hostname="zapliga-$EGRESS_SLOT" \
          --advertise-tags=tag:zapliga-edge --accept-dns=false; then
        log "vaga entrou na Tailscale"
        current_exit="unknown"
        sleep_for=1
      else
        log "não consegui entrar na Tailscale"
      fi
    else
      # A pong through a DERP relay still exits 1 ("direct connection not established"): judge by the pong.
      if tailscale ping -c 1 --timeout 3s "$exit_node" 2>&1 | grep -q '^pong from'; then
        # Only the traffic of a slot pointed at the PC tells whether the PC passes internet.
        if [ "$current_exit" != "$exit_node" ] && [ $(( $(date +%s) - no_internet_at )) -ge "$INTERNET_RETRY_SECONDS" ]; then
          set_exit_node "$exit_node" || true
        fi
        if [ "$current_exit" != "$exit_node" ]; then
          wanted=$route
        elif internet_through_pc; then
          misses=0
          wanted=pc
        else
          misses=$((misses + 1))
          failure=internet
          no_internet_at=$(date +%s)
          if [ "$misses" -ge "$MISSES_BEFORE_FALLBACK" ]; then wanted=$fallback; else wanted=$route; fi
        fi
      else
        misses=$((misses + 1))
        failure=ping
        if [ "$misses" -ge "$MISSES_BEFORE_FALLBACK" ]; then wanted=$fallback; else wanted=$route; fi
      fi
      # Until a route is chosen, keep the exit node set: Tailscale drops the traffic.
      case "$wanted" in vps) exit_wanted="" ;; *) exit_wanted=$exit_node ;; esac
      if set_exit_node "$exit_wanted"; then
        case "$wanted" in
          pc|offline|vps)
            if [ "$wanted" != "$route" ]; then
              if [ "$failure" = internet ]; then problem="responde mas não passa internet (veja se está como exit node e com internet)"; else problem="sem resposta"; fi
              case "$wanted" in
                pc) log "saindo pelo PC $exit_node" ;;
                offline) log "PC $exit_node $problem: números sem internet até ele voltar" ;;
                vps) log "PC $exit_node $problem: saindo pela VPS" ;;
              esac
            fi
            route=$wanted ;;
        esac
      fi
    fi
  fi
  [ -n "$route" ] && printf '%s\n' "$route" > "$ROUTE_FILE"
  sleep "$sleep_for"
done
wait "$daemon"
