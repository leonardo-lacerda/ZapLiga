/**
 * Calls only go out through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).
 * A line on the VPS, or on a PC slot that is not going out through its PC, does not
 * dial: calling from the VPS IP is what gets the number locked by WhatsApp.
 */

/** A PC slot that has not reported for this long no longer counts as online. */
export const REPORT_STALE_SECONDS = 60;

/** SQL condition: the line `alias` sits on a PC slot that goes out through its PC right now. */
export const onPcNetworkSql = (alias: string) =>
  `EXISTS (SELECT 1 FROM egress_pcs pc_net WHERE pc_net.slot = ${alias}.waxum_node AND pc_net.route = 'pc' AND pc_net.route_reported_at > now() - make_interval(secs => ${REPORT_STALE_SECONDS}))`;

export const OFF_PC_NETWORK_CODE = 'line_off_pc_network';
export const OFF_PC_NETWORK_MESSAGE = 'Nenhuma rede de PC conectada: a linha só está na VPS, e ligar pela VPS faz o WhatsApp bloquear o número. Ligue um PC com a Tailscale e tente de novo.';
