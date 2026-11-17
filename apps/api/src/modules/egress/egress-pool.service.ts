import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { MAIN_WAXUM_NODE } from '../../infrastructure/waxum/waxum.client';
import { NumbersService } from '../numbers/numbers.service';
import { EgressService, REPORT_STALE_SECONDS } from './egress.service';

const TICK_MS = 30_000;
// A few moves per tick: each one drops the line for some seconds, and a burst
// of logins from one IP is what WhatsApp should not see.
const MAX_MOVES_PER_TICK = 2;
const LEADER_LOCK = 'zapcall:global:lock:egress-pool';
const CONNECTED = ['connected', 'online', 'ready', 'authenticated'];

/**
 * Spreads the lines across the attendants' PCs (docs/saida-pelo-pc-do-atendente.md):
 * - a paired line on the VPS goes to the online PC with the fewest lines, up to
 *   max_numbers_per_pc;
 * - the lines of a PC that has been offline for offline_grace_seconds go to
 *   another online PC; with none, to the VPS if the PC's fallback is `vps`.
 * A line never returns on its own to the PC it left, so its IP does not flap.
 */
@Injectable()
export class EgressPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EgressPoolService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly egress: EgressService, private readonly numbers: NumbersService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick().catch((error) => this.logger.warn(`Egress pool tick failed: ${String(error?.message ?? error).slice(0, 300)}`)), TICK_MS);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    // One instance per tick; the lock simply expires.
    if (!await this.redis.acquireLock(LEADER_LOCK, randomUUID(), TICK_MS - 1000).catch(() => false)) return;
    const settings = (await this.db.query('SELECT pool_enabled, max_numbers_per_pc, offline_grace_seconds FROM egress_settings')).rows[0];
    if (!settings?.pool_enabled) return;
    await this.egress.syncPcs();

    const pcs = (await this.db.query(`
      SELECT slot, fallback,
        route = 'pc' AND route_reported_at > now() - make_interval(secs => $1) AS online,
        offline_since IS NOT NULL AND offline_since < now() - make_interval(secs => $2) AS gone
      FROM egress_pcs WHERE slot IS NOT NULL
    `, [REPORT_STALE_SECONDS, settings.offline_grace_seconds])).rows;
    const lines = (await this.db.query(`SELECT id, tenant_id, waxum_node, status FROM whatsapp_numbers WHERE status <> 'removed' AND phone IS NOT NULL ORDER BY created_at`)).rows;
    const load = new Map<string, number>(pcs.map((pc) => [pc.slot, lines.filter((line) => line.waxum_node === pc.slot).length]));
    const online = pcs.filter((pc) => pc.online);
    const target = () => online
      .filter((pc) => (load.get(pc.slot) ?? 0) < settings.max_numbers_per_pc)
      .sort((a, b) => (load.get(a.slot) ?? 0) - (load.get(b.slot) ?? 0))[0]?.slot as string | undefined;

    const moves: Array<{ line: any; to: string }> = [];
    for (const line of lines) {
      if (moves.length >= MAX_MOVES_PER_TICK) break;
      let to: string | undefined;
      if (line.waxum_node === MAIN_WAXUM_NODE) {
        if (CONNECTED.includes(line.status)) to = target();
      } else {
        const pc = pcs.find((row) => row.slot === line.waxum_node);
        // A slot whose PC was removed, or a PC offline past the grace period.
        if (!pc || (!pc.online && pc.gone)) to = target() ?? (!pc || pc.fallback === 'vps' ? MAIN_WAXUM_NODE : undefined);
      }
      if (!to) continue;
      moves.push({ line, to });
      load.set(line.waxum_node, (load.get(line.waxum_node) ?? 1) - 1);
      load.set(to, (load.get(to) ?? 0) + 1);
    }

    for (const { line, to } of moves) {
      try {
        await this.numbers.moveToWaxumNode(line.tenant_id, null, line.id, to);
        this.logger.log(`Line ${line.id} moved from ${line.waxum_node} to ${to}`);
      } catch (error) {
        this.logger.warn(`Line ${line.id} not moved to ${to}: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
      }
    }
  }
}
