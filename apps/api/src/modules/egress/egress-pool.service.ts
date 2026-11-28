import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { MAIN_WAXUM_NODE } from '../../infrastructure/waxum/waxum.client';
import { NumbersService } from '../numbers/numbers.service';
import { EgressService, REPORT_STALE_SECONDS } from './egress.service';
import { STEADY_ONLINE_SECONDS } from './pc-network';

const TICK_MS = 30_000;
// A few moves per tick: each one drops the line for some seconds, and a burst
// of logins from one IP is what WhatsApp should not see.
const MAX_MOVES_PER_TICK = 2;
const LEADER_LOCK = 'zapcall:global:lock:egress-pool';
// A line whose move failed waits this long before the next try, so it does not hold
// back, tick after tick, the lines behind it.
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
// A line paired this recently stays where it was paired: WhatsApp judges the new device on
// its first call, and a login from another place right before it is one more signal.
const PAIRING_SETTLE_MINUTES = 30;
// A line in one of these holds a live WhatsApp session that a move has to hand over.
const CONNECTED = ['connected', 'online', 'ready', 'authenticated'];

/**
 * Spreads the lines across the attendants' PCs (docs/saida-pelo-pc-do-atendente.md):
 * - a paired line on the VPS goes to the online PC with the fewest lines, up to
 *   max_numbers_per_pc; only a PC online without a break for STEADY_ONLINE_SECONDS
 *   receives lines;
 * - the lines of a PC that has been offline for offline_grace_seconds go to
 *   another online PC; with none, they wait for a PC. A line never goes to the VPS:
 *   a datacenter IP is a ban signal.
 * Disconnected lines move too: a PC that goes away takes their connection with it, and
 * the device keys sit in the storage every Waxum shares, so the target reconnects them.
 * A disconnected line only goes to another online PC (never to the VPS, where its pairing
 * would come from the VPS IP): it has no live session, so it just changes Waxum and its
 * next QR or code is born there (NumbersService.moveToWaxumNode).
 * Lines WhatsApp removed or locked stay put: they need a new QR or the phone, not a move.
 * A line never returns on its own to the PC it left, so its IP does not flap.
 */
@Injectable()
export class EgressPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EgressPoolService.name);
  private timer?: NodeJS.Timeout;
  private readonly failedUntil = new Map<string, number>();

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly egress: EgressService, private readonly numbers: NumbersService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.warn(`Egress pool tick failed: ${String(error?.message ?? error).slice(0, 300)}`)), TICK_MS);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    // One instance per tick; the lock simply expires.
    if (!await this.redis.acquireLock(LEADER_LOCK, randomUUID(), TICK_MS - 1000).catch(() => false)) return;
    await this.egress.recordSilentPcs().catch((error) => this.logger.warn(`Silent PCs not recorded: ${String(error?.message ?? error).slice(0, 200)}`));
    const settings = (await this.db.query('SELECT pool_enabled, max_numbers_per_pc, offline_grace_seconds FROM egress_settings')).rows[0];
    if (!settings?.pool_enabled) return;
    await this.egress.syncPcs();

    const pcs = (await this.db.query(`
      SELECT slot,
        route = 'pc' AND route_reported_at > now() - make_interval(secs => $1) AS online,
        -- Gone: reporting a route other than the PC past the grace period, or the slot itself
        -- silent that long (it never set offline_since if its last report was still 'pc').
        (offline_since IS NOT NULL AND offline_since < now() - make_interval(secs => $2))
          OR route_reported_at IS NULL OR route_reported_at < now() - make_interval(secs => $1 + $2) AS gone,
        online_since < now() - make_interval(secs => $3) AS steady
      FROM egress_pcs WHERE slot IS NOT NULL
    `, [REPORT_STALE_SECONDS, settings.offline_grace_seconds, STEADY_ONLINE_SECONDS])).rows;
    const lines = (await this.db.query(`
      SELECT id, tenant_id, waxum_node, status FROM whatsapp_numbers
      WHERE status <> 'removed' AND phone IS NOT NULL AND loss_reason IS NULL AND NOT COALESCE(dial_block_cause = 'temp_banned' AND dial_blocked_until > now(), false) AND waxum_node NOT LIKE 'proxy-%'
        AND (last_paired_at IS NULL OR last_paired_at < now() - make_interval(mins => $1))
      ORDER BY created_at
    `, [PAIRING_SETTLE_MINUTES])).rows;
    const load = new Map<string, number>(pcs.map((pc) => [pc.slot, lines.filter((line) => line.waxum_node === pc.slot).length]));
    const online = pcs.filter((pc) => pc.online && pc.steady);
    const target = () => online
      .filter((pc) => (load.get(pc.slot) ?? 0) < settings.max_numbers_per_pc)
      .sort((a, b) => (load.get(a.slot) ?? 0) - (load.get(b.slot) ?? 0))[0]?.slot as string | undefined;

    const moves: Array<{ line: any; to: string }> = [];
    for (const line of lines) {
      if (moves.length >= MAX_MOVES_PER_TICK) break;
      if ((this.failedUntil.get(line.id) ?? 0) > Date.now()) continue;
      const connected = CONNECTED.includes(line.status);
      let to: string | undefined;
      if (line.waxum_node === MAIN_WAXUM_NODE) {
        // A disconnected line on the VPS stays: it is paired where it is.
        if (connected) to = target();
      } else {
        const pc = pcs.find((row) => row.slot === line.waxum_node);
        // A slot whose PC was removed, or a PC offline past the grace period. A disconnected
        // line there could never pair (the slot's Waxum does not run without its PC), and it
        // never goes to the VPS: its pairing would come from the datacenter IP.
        if (!pc || (!pc.online && pc.gone)) to = target();
      }
      if (!to) continue;
      moves.push({ line, to });
      load.set(line.waxum_node, (load.get(line.waxum_node) ?? 1) - 1);
      load.set(to, (load.get(to) ?? 0) + 1);
    }

    for (const { line, to } of moves) {
      try {
        await this.numbers.moveToWaxumNode(line.tenant_id, null, line.id, to);
        this.failedUntil.delete(line.id);
        this.logger.log(`Line ${line.id} moved from ${line.waxum_node} to ${to}`);
      } catch (error) {
        this.failedUntil.set(line.id, Date.now() + RETRY_AFTER_FAILURE_MS);
        this.logger.warn(`Line ${line.id} not moved to ${to}: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
      }
    }
  }
}
