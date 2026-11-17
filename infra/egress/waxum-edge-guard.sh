#!/bin/sh
# One PC slot: the Waxum side (docs/saida-pelo-pc-do-atendente.md). It shares the
# network of the slot's Tailscale container, so it only starts once that
# container has put a PC route in place (infra/egress/edge-entrypoint.sh);
# a slot with no PC keeps its Waxum waiting here.
set -eu

echo "Aguardando a vaga ${EGRESS_SLOT:-} ter um PC..."
until grep -qxE 'pc|offline|vps' "$EGRESS_ROUTE_FILE" 2>/dev/null; do
  sleep 2
done
exec /bin/sh /usr/local/bin/waxum-entrypoint-guard.sh "$@"
