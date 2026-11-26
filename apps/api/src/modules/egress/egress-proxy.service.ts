import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { DatabaseService } from '../../database/database.service';
import { waxumNodes } from '../../infrastructure/waxum/waxum.client';
import { AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret } from '../lead-ingestion/lead-ingestion.crypto';
import { isProxySlot, REPORT_STALE_SECONDS } from './pc-network';

// The day of a usage row: the operation's day, not UTC's.
const USAGE_TIMEZONE = 'America/Sao_Paulo';

export type ProxyReport = { route: string; rxBytes: number; txBytes: number; udpRxBytes: number; udpTxBytes: number; exitIp: string; udpOk: boolean; latencyMs: number | null; error: string };

/**
 * A proxy accepts what the provider hands out: `host:port:user:password` (Roundproxies'
 * "copy" format) or `socks5://user:password@host:port`. Only SOCKS5, which carries UDP.
 */
export function parseProxy(input: string): { host: string; port: number; user: string; password: string } {
  const text = input.trim();
  let host = ''; let port = 0; let user = ''; let password = '';
  if (/^socks5h?:\/\//i.test(text)) {
    const url = new URL(text.replace(/^socks5h?:/i, 'http:'));
    host = url.hostname; port = Number(url.port); user = decodeURIComponent(url.username); password = decodeURIComponent(url.password);
  } else {
    const parts = text.split(':');
    if (parts.length < 4) throw new BadRequestException('Cole a proxy como host:porta:usuário:senha ou socks5://usuário:senha@host:porta');
    [host, , user] = parts;
    port = Number(parts[1]);
    password = parts.slice(3).join(':');
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password) throw new BadRequestException('Proxy inválida: faltam host, porta, usuário ou senha');
  return { host, port, user, password };
}

/**
 * Proxy slots (docs/saida-por-proxy.md): the lines of a proxy slot go out through a residential
 * SOCKS5 proxy, UDP included, instead of an attendant's PC. The slot's watcher
 * (infra/egress/proxy-entrypoint.sh) asks here for its proxy and reports, every minute, its route,
 * exit IP, UDP check and the bytes it moved, which become the GB per line and day.
 */
@Injectable()
export class EgressProxyService {
  private readonly logger = new Logger(EgressProxyService.name);

  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  slots() { return [...waxumNodes().keys()].filter(isProxySlot); }

  async list() {
    const rows = (await this.db.query(`
      SELECT p.id, p.name, p.slot, p.route, p.route_reported_at, p.exit_ip, p.exit_ip_changed_at, p.udp_ok, p.latency_ms, p.last_error, p.created_at,
        COALESCE(p.route = 'proxy' AND p.route_reported_at > now() - make_interval(secs => $1), false) AS online,
        (SELECT json_agg(json_build_object('id', n.id, 'label', n.label, 'status', n.status)) FROM whatsapp_numbers n WHERE n.waxum_node = p.slot AND n.status <> 'removed') AS lines,
        (SELECT COALESCE(sum(u.rx_bytes + u.tx_bytes), 0)::bigint FROM egress_proxy_usage u WHERE u.slot = p.slot AND u.day = (now() AT TIME ZONE $2)::date) AS today_bytes,
        (SELECT COALESCE(sum(u.udp_rx_bytes + u.udp_tx_bytes), 0)::bigint FROM egress_proxy_usage u WHERE u.slot = p.slot AND u.day = (now() AT TIME ZONE $2)::date) AS today_udp_bytes,
        (SELECT COALESCE(sum(u.rx_bytes + u.tx_bytes), 0)::bigint FROM egress_proxy_usage u WHERE u.slot = p.slot AND u.day >= date_trunc('month', now() AT TIME ZONE $2)::date) AS month_bytes,
        (SELECT json_agg(e ORDER BY e.occurred_at DESC) FROM (SELECT kind, detail, occurred_at FROM egress_proxy_events WHERE slot = p.slot ORDER BY occurred_at DESC LIMIT 10) e) AS events
      FROM egress_proxies p ORDER BY p.created_at
    `, [REPORT_STALE_SECONDS, USAGE_TIMEZONE])).rows;
    const used = new Set(rows.map((row) => row.slot));
    return { items: rows, freeSlots: this.slots().filter((slot) => !used.has(slot)) };
  }

  async create(actorUserId: string, input: { name: string; proxy: string }) {
    const proxy = parseProxy(input.proxy);
    const slot = (await this.list()).freeSlots[0];
    if (!slot) throw new BadRequestException('Todas as vagas de proxy estão ocupadas');
    const url = `socks5://${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
    const row = (await this.db.query('INSERT INTO egress_proxies (name, slot, proxy_url_encrypted) VALUES ($1, $2, $3) RETURNING id, name, slot', [input.name, slot, encryptSecret(url)])).rows[0];
    await this.audit.record({ actorUserId, action: 'egress.proxy_added', entityType: 'egress_proxy', entityId: row.id, metadata: { name: row.name, slot, host: proxy.host, port: proxy.port } });
    return row;
  }

  /** A proxy with lines on it cannot go: they would be left without internet. */
  async remove(actorUserId: string, id: string) {
    const row = (await this.db.query('SELECT id, name, slot FROM egress_proxies WHERE id = $1', [id])).rows[0];
    if (!row) throw new NotFoundException('Proxy não encontrada');
    const lines = (await this.db.query("SELECT count(*)::int AS total FROM whatsapp_numbers WHERE waxum_node = $1 AND status <> 'removed'", [row.slot])).rows[0].total;
    if (lines) throw new BadRequestException('Mova as linhas desta proxy para um PC antes de removê-la');
    await this.db.query('DELETE FROM egress_proxies WHERE id = $1', [id]);
    await this.audit.record({ actorUserId, action: 'egress.proxy_removed', entityType: 'egress_proxy', entityId: id, metadata: { name: row.name, slot: row.slot } });
    return { removed: true };
  }

  /**
   * The slot's proxy as `proxy=socks5://user:pass@IP:port`. The host is resolved here: inside the
   * slot only the tunnel reaches the internet, so it cannot ask a DNS server for the proxy itself.
   * Lowest address first, so the answer does not flip between polls.
   */
  async slotConfig(slot: string) {
    if (!this.slots().includes(slot)) throw new NotFoundException(`Vaga ${slot} não existe`);
    const row = (await this.db.query('SELECT proxy_url_encrypted FROM egress_proxies WHERE slot = $1', [slot])).rows[0];
    if (!row) return 'proxy=\n';
    const url = new URL(decryptSecret(row.proxy_url_encrypted).replace(/^socks5:/, 'http:'));
    const address = isIP(url.hostname) ? url.hostname : (await dns.resolve4(url.hostname)).sort()[0];
    return `proxy=socks5://${url.username}:${url.password}@${address}:${url.port}\n`;
  }

  /** One report of the slot's watcher: status, events on changes, and the bytes into the day's usage. */
  async report(slot: string, report: ProxyReport) {
    if (!this.slots().includes(slot)) throw new NotFoundException(`Vaga ${slot} não existe`);
    const before = (await this.db.query('SELECT route, exit_ip FROM egress_proxies WHERE slot = $1', [slot])).rows[0];
    if (!before) return { ok: true };
    const exitIp = report.exitIp || null;
    const ipChanged = Boolean(exitIp && before.exit_ip && exitIp !== before.exit_ip);
    await this.db.query(`
      UPDATE egress_proxies SET route = $2, route_reported_at = now(), exit_ip = COALESCE($3, exit_ip),
        exit_ip_changed_at = CASE WHEN $4 THEN now() ELSE exit_ip_changed_at END,
        udp_ok = $5, latency_ms = COALESCE($6, latency_ms), last_error = NULLIF($7, '')
      WHERE slot = $1
    `, [slot, report.route, exitIp, ipChanged, report.udpOk, report.latencyMs, report.error]);
    if (ipChanged) {
      this.logger.warn(`Proxy slot ${slot}: exit IP changed ${before.exit_ip} -> ${exitIp}`);
      await this.db.query("INSERT INTO egress_proxy_events (slot, kind, detail) VALUES ($1, 'ip_changed', $2::jsonb)", [slot, JSON.stringify({ from: before.exit_ip, to: exitIp })]);
    }
    if (before.route !== report.route && (report.route === 'proxy' || before.route === 'proxy')) {
      await this.db.query('INSERT INTO egress_proxy_events (slot, kind, detail) VALUES ($1, $2, $3::jsonb)', [slot, report.route === 'proxy' ? 'up' : 'down', JSON.stringify({ error: report.error || null, exitIp })]);
    }
    const bytes = [report.rxBytes, report.txBytes, report.udpRxBytes, report.udpTxBytes];
    if (bytes.some((value) => value > 0)) {
      // A proxy slot holds one line; with none (or more), the bytes stay on the slot.
      const lines = (await this.db.query("SELECT id FROM whatsapp_numbers WHERE waxum_node = $1 AND status <> 'removed'", [slot])).rows;
      await this.db.query(`
        INSERT INTO egress_proxy_usage (slot, day, number_id, rx_bytes, tx_bytes, udp_rx_bytes, udp_tx_bytes)
        VALUES ($1, (now() AT TIME ZONE $2)::date, $3, $4, $5, $6, $7)
        ON CONFLICT (slot, day, number_id) DO UPDATE SET rx_bytes = egress_proxy_usage.rx_bytes + EXCLUDED.rx_bytes, tx_bytes = egress_proxy_usage.tx_bytes + EXCLUDED.tx_bytes,
          udp_rx_bytes = egress_proxy_usage.udp_rx_bytes + EXCLUDED.udp_rx_bytes, udp_tx_bytes = egress_proxy_usage.udp_tx_bytes + EXCLUDED.udp_tx_bytes, updated_at = now()
      `, [slot, USAGE_TIMEZONE, lines.length === 1 ? lines[0].id : '', ...bytes]);
    }
    return { ok: true };
  }
}
