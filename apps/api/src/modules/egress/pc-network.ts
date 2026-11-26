/**
 * Calls only go out through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).
 * A line on the VPS, or on a PC slot that is not going out through its PC, does not
 * dial: calling from the VPS IP is what gets the number locked by WhatsApp.
 */

/** A PC slot that has not reported for this long no longer counts as online. */
export const REPORT_STALE_SECONDS = 60;

/**
 * A PC only receives lines (new ones, or moved by the egress pool) after going out
 * through it without a break for this long: a PC that keeps dropping would otherwise
 * take back, seconds after answering again, the lines that just left it.
 */
export const STEADY_ONLINE_SECONDS = 600;

/** Proxy slots (docs/saida-por-proxy.md) are named proxy-N; every other node but `main` is a PC slot. */
export const PROXY_SLOT_PREFIX = 'proxy-';
export const isProxySlot = (slot: string) => slot.startsWith(PROXY_SLOT_PREFIX);

/** SQL condition: slot `slotExpr` goes out right now through its PC, or through its proxy with UDP passing. */
export const slotOnlineSql = (slotExpr: string) =>
  `(EXISTS (SELECT 1 FROM egress_pcs pc_net WHERE pc_net.slot = ${slotExpr} AND pc_net.route = 'pc' AND pc_net.route_reported_at > now() - make_interval(secs => ${REPORT_STALE_SECONDS}))
    OR EXISTS (SELECT 1 FROM egress_proxies px_net WHERE px_net.slot = ${slotExpr} AND px_net.route = 'proxy' AND px_net.route_reported_at > now() - make_interval(secs => ${REPORT_STALE_SECONDS})))`;

/** SQL condition: the line `alias` sits on a slot that goes out through its PC or its proxy right now. */
export const onPcNetworkSql = (alias: string) => slotOnlineSql(`${alias}.waxum_node`);

export const OFF_PC_NETWORK_CODE = 'line_off_pc_network';
export const OFF_PC_NETWORK_MESSAGE = 'Nenhuma rede de PC conectada: a linha só está na VPS, e ligar pela VPS faz o WhatsApp bloquear o número. Ligue um PC com a Tailscale e tente de novo.';
