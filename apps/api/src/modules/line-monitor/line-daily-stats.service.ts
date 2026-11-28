import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { LineLearningsService } from './line-learnings.service';
import { DEFAULT_TIMEZONE, UPSERT_LINE_DAY_SQL, daysBetween, localDay, shiftDay, upsertLineDayParams } from './line-monitor.rules';

const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 60_000;
const LEADER_LOCK = 'zapcall:global:lock:line-daily-stats';
// Calls of the day before still finish (and losses still arrive) right after midnight.
const CLOSE_PREVIOUS_DAY_UNTIL_HOUR = 2;
// The learnings are recomputed once a night, at this local hour.
const NIGHTLY_LEARNINGS_HOUR = 3;

/**
 * Keeps `line_daily_stats` (migration 085, docs/line-monitor.md): every 15 min, one instance
 * rebuilds today's row of every line of every active tenant, and yesterday's in the first hours of
 * the day. A tenant without any row gets every day since its first call rebuilt once, with the
 * setup columns copied from the lines as they are now (config_estimated). Once a night it also
 * saves a new computation of the learnings.
 */
@Injectable()
export class LineDailyStatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LineDailyStatsService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly db: DatabaseService, private readonly learnings: LineLearningsService, @Optional() private readonly redis?: RedisService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    const run = () => void this.tick().catch((error) => this.logger.warn(`Line daily stats failed: ${String(error?.message ?? error).slice(0, 300)}`));
    this.timers = [setTimeout(run, FIRST_TICK_MS), setInterval(run, TICK_MS)];
    this.timers.forEach((timer) => timer.unref?.());
  }

  onModuleDestroy() { this.timers.forEach((timer) => clearTimeout(timer)); }

  async tick(now = new Date()) {
    if (this.redis && !await this.redis.acquireLock(LEADER_LOCK, randomUUID(), TICK_MS - 60_000).catch(() => false)) return;
    const tenants = (await this.db.query<{ id: string; timezone: string }>(
      `SELECT id, COALESCE(timezone, $1) AS timezone FROM tenants WHERE status = 'active' ORDER BY id`, [DEFAULT_TIMEZONE],
    )).rows;
    for (const tenant of tenants) {
      const { day, hour } = localDay(now, tenant.timezone);
      await this.backfill(tenant.id, tenant.timezone, shiftDay(day, -1));
      if (hour < CLOSE_PREVIOUS_DAY_UNTIL_HOUR) await this.upsertDay(tenant.id, shiftDay(day, -1), tenant.timezone);
      await this.upsertDay(tenant.id, day, tenant.timezone);
      if (hour >= NIGHTLY_LEARNINGS_HOUR && !(await this.learnings.hasNightlyRun(tenant.id, day))) {
        await this.learnings.compute(tenant.id, { trigger: 'nightly' }).catch((error) => this.logger.warn(`Nightly learnings of ${tenant.id} failed: ${String(error?.message ?? error).slice(0, 300)}`));
      }
    }
  }

  upsertDay(tenantId: string, day: string, timezone: string, estimated = false) {
    return this.db.query(UPSERT_LINE_DAY_SQL, upsertLineDayParams(tenantId, day, timezone, estimated));
  }

  /** Rebuilds every past day of a tenant that has no row yet, from its first call until `lastDay`. */
  async backfill(tenantId: string, timezone: string, lastDay: string) {
    if ((await this.db.query('SELECT 1 FROM line_daily_stats WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows[0]) return 0;
    const first = (await this.db.query<{ day: string | null }>(
      `SELECT to_char(min(created_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS day FROM calls WHERE tenant_id = $1`, [tenantId, timezone],
    )).rows[0]?.day;
    if (!first || first > lastDay) return 0;
    const days = daysBetween(first, lastDay);
    for (const day of days) await this.upsertDay(tenantId, day, timezone, true);
    this.logger.log(`Line daily stats of ${tenantId} rebuilt for ${days.length} days since ${first}`);
    return days.length;
  }
}
