#!/bin/sh
# One proxy slot: every byte of the slot's network namespace (its Waxum shares it) goes out
# through a residential SOCKS5 proxy, UDP included, so the line keeps one IP of its own
# (docs/saida-por-proxy.md). Runs in the tun2socks image.
#
# - The proxy comes from the API (Admin → Saídas de internet → Proxies); nothing about it lives
#   on the server. Without one, or while it is down, the slot has no internet: a kill switch only
#   lets eth0 reach the proxy server and the compose network, never the internet from the VPS IP.
# - Every REPORT_SECONDS it reports to the API the bytes the slot sent and received through the
#   proxy since the last report (total and UDP, which is the call media), the exit IP, whether
#   UDP passes and the latency, so the operation sees the GB each line spends.
set -eu

: "${EGRESS_SLOT:?EGRESS_SLOT: name of the slot, e.g. proxy-1}"
: "${WAXUM_API_KEY:?WAXUM_API_KEY: key shared with the API}"
API_URLS="${EGRESS_API_URLS:-http://api-a:3000 http://api-b:3000}"
ROUTE_FILE=/egress/route
TUN=tun0
REPORT_SECONDS="${EGRESS_REPORT_SECONDS:-60}"
CHECK_EVERY_REPORTS=5
# What the line reaches the internet through is checked against these.
IP_URL="${EGRESS_IP_URL:-https://api.ipify.org}"
STUN_HOST="${EGRESS_STUN_HOST:-stun.l.google.com}"
STUN_PORT="${EGRESS_STUN_PORT:-19302}"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') proxy: $*"; }

mkdir -p /egress
echo offline > "$ROUTE_FILE"

api() {
  # $1 = method, $2 = path, $3 = body (POST)
  # Local test without the API: the slot config comes from a read-only file and the reports go
  # to the log (EGRESS_CONFIG_FILE).
  if [ -n "${EGRESS_CONFIG_FILE:-}" ]; then
    if [ "$1" = GET ]; then cat "$EGRESS_CONFIG_FILE"; else log "relatório $3"; fi
    return 0
  fi
  for base in $API_URLS; do
    if [ "$1" = GET ]; then
      wget -q -T 5 -O - --header "Authorization: Bearer $WAXUM_API_KEY" "$base$2" 2>/dev/null && return 0
    else
      wget -q -T 5 -O - --header "Authorization: Bearer $WAXUM_API_KEY" --header 'Content-Type: application/json' --post-data "$3" "$base$2" >/dev/null 2>&1 && return 0
    fi
  done
  return 1
}

value() { printf '%s\n' "$config" | sed -n "s/^$1=//p" | head -1; }

# The compose network (the API, NATS, the Waxum's own port) stays on eth0.
gateway=$(ip route show default | awk '/default/ { print $3; exit }')
local_net=$(ip -o -f inet addr show eth0 | awk '{ print $4; exit }')

kill_switch() {
  # $1 = proxy host: eth0 only reaches the compose network and that host.
  iptables -F OUTPUT
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -o "$TUN" -p udp -j ACCEPT
  iptables -A OUTPUT -o "$TUN" -j ACCEPT
  iptables -A OUTPUT -o eth0 -d "$local_net" -j ACCEPT
  # Docker's embedded DNS answers on 127.0.0.11 and forwards from the host.
  for proxy_ip in $(getent ahostsv4 "$1" | awk '{ print $1 }' | sort -u); do
    iptables -A OUTPUT -o eth0 -d "$proxy_ip" -j ACCEPT
  done
  iptables -A OUTPUT -o eth0 -j DROP
  iptables -F INPUT
  iptables -A INPUT -i "$TUN" -p udp -j ACCEPT
}

if ! ip link show "$TUN" >/dev/null 2>&1; then
  ip tuntap add mode tun dev "$TUN"
  ip addr add 198.18.0.1/15 dev "$TUN"
  ip link set dev "$TUN" up
fi
# The tunnel wins; eth0 keeps a fallback default only so tun2socks, bound to eth0, can reach
# the proxy. The kill switch drops anything else on eth0.
ip route del default via "$gateway" dev eth0 2>/dev/null || true
ip route replace default via "$gateway" dev eth0 metric 200
ip route replace default dev "$TUN" metric 1
iptables -P OUTPUT ACCEPT
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -o eth0 -d "$local_net" -j ACCEPT
iptables -A OUTPUT -o eth0 -j DROP

counter() { iptables -nvxL "$1" | awk -v dev="$2" '$3 == "ACCEPT" && $4 == "udp" && ($6 == dev || $7 == dev) { print $2; exit }'; }
stat_of() { cat "/sys/class/net/$TUN/statistics/$1"; }
now_ms() { awk '{ printf "%d", $1 * 1000 }' /proc/uptime; }

current_proxy=""
pid=""
reports=0
last_rx=$(stat_of rx_bytes); last_tx=$(stat_of tx_bytes); last_urx=0; last_utx=0
exit_ip=""; udp_ok=false; latency_ms=""; error=""

while true; do
  # The tunnel and its route come back by themselves if anything took them down.
  ip link set dev "$TUN" up 2>/dev/null || true
  ip route replace default dev "$TUN" metric 1 2>/dev/null || true
  if config=$(api GET "/api/internal/egress/proxy-slots/$EGRESS_SLOT"); then
    proxy=$(value proxy)
    if [ "$proxy" != "$current_proxy" ] || { [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; }; then
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
      pid=""
      current_proxy="$proxy"
      if [ -n "$proxy" ]; then
        host=$(printf '%s' "$proxy" | sed -E 's#^[a-z0-9]+://([^@]*@)?([^:/]+).*#\2#')
        kill_switch "$host"
        tun2socks -device "$TUN" -proxy "$proxy" -interface eth0 -loglevel warn &
        pid=$!
        log "saindo pela proxy $host (pid $pid)"
        reports=$CHECK_EVERY_REPORTS
      else
        echo offline > "$ROUTE_FILE"
        log "nenhuma proxy nesta vaga: números sem internet"
      fi
    fi
  fi

  if [ -n "$pid" ]; then
    reports=$((reports + 1))
    if [ "$reports" -ge "$CHECK_EVERY_REPORTS" ]; then
      reports=0
      started=$(now_ms)
      new_ip=$(wget -q -T 15 -O - "$IP_URL" 2>/dev/null | tr -dc '0-9a-fA-F.:' || true)
      finished=$(now_ms)
      latency_ms=$((finished - started))
      # A STUN Binding Request: any answer means UDP goes out and comes back through the proxy.
      if printf '\000\001\000\000\041\022\244\102ZAPLIGASTUN0' | nc -u -w 4 "$STUN_HOST" "$STUN_PORT" 2>/dev/null | head -c 1 | grep -q .; then udp_ok=true; else udp_ok=false; fi
      if [ -z "$new_ip" ]; then
        error="sem resposta pela proxy"; echo offline > "$ROUTE_FILE"; log "proxy sem resposta"
      else
        error=""
        [ -n "$exit_ip" ] && [ "$new_ip" != "$exit_ip" ] && log "IP de saída mudou: $exit_ip -> $new_ip"
        exit_ip="$new_ip"
        if [ "$udp_ok" = true ]; then echo proxy > "$ROUTE_FILE"; else echo offline > "$ROUTE_FILE"; error="UDP não passa pela proxy"; fi
        log "saída $exit_ip, UDP $udp_ok, ${latency_ms} ms"
      fi
    fi
  fi

  rx=$(stat_of rx_bytes); tx=$(stat_of tx_bytes)
  urx=$(counter INPUT "$TUN" || echo 0); utx=$(counter OUTPUT "$TUN" || echo 0)
  urx=${urx:-0}; utx=${utx:-0}
  # Counters restart when the kill switch is rebuilt: never report a negative delta.
  d_rx=$((rx - last_rx)); d_tx=$((tx - last_tx)); d_urx=$((urx - last_urx)); d_utx=$((utx - last_utx))
  [ "$d_rx" -lt 0 ] && d_rx=$rx; [ "$d_tx" -lt 0 ] && d_tx=$tx
  [ "$d_urx" -lt 0 ] && d_urx=$urx; [ "$d_utx" -lt 0 ] && d_utx=$utx
  route=$(cat "$ROUTE_FILE")
  body=$(printf '{"route":"%s","rxBytes":%s,"txBytes":%s,"udpRxBytes":%s,"udpTxBytes":%s,"exitIp":"%s","udpOk":%s,"latencyMs":%s,"error":"%s"}' \
    "$route" "$d_rx" "$d_tx" "$d_urx" "$d_utx" "$exit_ip" "$udp_ok" "${latency_ms:-null}" "$error")
  if api POST "/api/internal/egress/proxy-slots/$EGRESS_SLOT/report" "$body"; then
    last_rx=$rx; last_tx=$tx; last_urx=$urx; last_utx=$utx
  fi
  sleep "$REPORT_SECONDS"
done
