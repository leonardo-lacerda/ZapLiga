import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { UpdateDialerScheduleDto } from './dto/update-dialer-schedule.dto';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { AuditService } from '../audit/audit.service';

type Window = { day_of_week: number; start_time: string; end_time: string };
type Exception = { local_date: string; is_closed: boolean; start_time: string | null; end_time: string | null; reason: string | null };
export type DialerSchedule = { timezone: string; windows: Window[]; exceptions: Exception[] };
export type ScheduleState = { allowed: boolean; timezone: string; local_date: string; local_time: string; reason: string; next_open_at?: string };

const hhmm = (value: unknown) => String(value ?? '').slice(0, 5);

export function localDateTimeParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { local_date: `${get('year')}-${get('month')}-${get('day')}`, local_time: `${get('hour')}:${get('minute')}`, day_of_week: weekday };
}

export function evaluateSchedule(schedule: DialerSchedule, at: Date): ScheduleState {
  const local = localDateTimeParts(at, schedule.timezone);
  const exception = schedule.exceptions.find((item) => item.local_date === local.local_date);
  if (exception?.is_closed) return { allowed: false, timezone: schedule.timezone, ...local, reason: exception.reason || 'closed_exception' };
  const windows = exception
    ? [{ day_of_week: local.day_of_week, start_time: exception.start_time!, end_time: exception.end_time! }]
    : schedule.windows.filter((item) => item.day_of_week === local.day_of_week);
  const allowed = windows.some((item) => local.local_time >= hhmm(item.start_time) && local.local_time < hhmm(item.end_time));
  return { allowed, timezone: schedule.timezone, ...local, reason: allowed ? 'within_schedule' : (exception ? exception.reason || 'outside_exception_window' : 'outside_schedule') };
}

@Injectable()
export class DialerScheduleService {
  private readonly cacheTtlSeconds = 300;
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, @Optional() private readonly flags?: FeatureFlagsService, @Optional() private readonly audit?: AuditService) {}

  private cacheKey(tenantId: string) { return `zapcall:tenant:${tenantId}:dialer:schedule`; }

  async get(tenantId: string): Promise<DialerSchedule> {
    const cached = await this.redis.client.get(this.cacheKey(tenantId)).catch(() => null);
    if (cached) { try { return JSON.parse(cached) as DialerSchedule; } catch { /* refaz cache inválido */ } }
    const [tenant, windows, exceptions] = await Promise.all([
      this.db.query<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = $1', [tenantId]),
      this.db.query<Window>(`SELECT day_of_week, start_time::text, end_time::text FROM dialer_schedule_windows WHERE tenant_id = $1 ORDER BY day_of_week, start_time`, [tenantId]),
      this.db.query<Exception>(`SELECT local_date::text, is_closed, start_time::text, end_time::text, reason FROM dialer_schedule_exceptions WHERE tenant_id = $1 ORDER BY local_date`, [tenantId]),
    ]);
    const schedule = { timezone: tenant.rows[0]?.timezone ?? 'America/Sao_Paulo', windows: windows.rows.map((row) => ({ ...row, start_time: hhmm(row.start_time), end_time: hhmm(row.end_time) })), exceptions: exceptions.rows.map((row) => ({ ...row, start_time: row.start_time ? hhmm(row.start_time) : null, end_time: row.end_time ? hhmm(row.end_time) : null })) };
    await this.redis.client.set(this.cacheKey(tenantId), JSON.stringify(schedule), 'EX', this.cacheTtlSeconds).catch(() => undefined);
    return schedule;
  }

  async update(tenantId: string, input: UpdateDialerScheduleDto) {
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: input.timezone }).format(); }
    catch { throw new BadRequestException('Fuso horário inválido'); }
    for (const window of input.windows) if (window.start_time >= window.end_time) throw new BadRequestException('O início da janela deve ser anterior ao fim');
    for (const exception of input.exceptions) {
      if (exception.is_closed && (exception.start_time || exception.end_time)) throw new BadRequestException('Uma exceção fechada não pode ter horários');
      if (!exception.is_closed && (!exception.start_time || !exception.end_time || exception.start_time >= exception.end_time)) throw new BadRequestException('Uma exceção aberta precisa de início anterior ao fim');
    }
    const duplicateDates = input.exceptions.map((item) => item.local_date).filter((date, index, all) => all.indexOf(date) !== index);
    if (duplicateDates.length) throw new ConflictException('Existe mais de uma exceção para a mesma data');
    await this.db.transaction(async (client) => {
      await client.query('UPDATE tenants SET timezone = $1 WHERE id = $2', [input.timezone, tenantId]);
      await client.query('DELETE FROM dialer_schedule_windows WHERE tenant_id = $1', [tenantId]);
      await client.query('DELETE FROM dialer_schedule_exceptions WHERE tenant_id = $1', [tenantId]);
      for (const window of input.windows) await client.query('INSERT INTO dialer_schedule_windows (tenant_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)', [tenantId, window.day_of_week, window.start_time, window.end_time]);
      for (const exception of input.exceptions) await client.query('INSERT INTO dialer_schedule_exceptions (tenant_id, local_date, is_closed, start_time, end_time, reason) VALUES ($1, $2, $3, $4, $5, $6)', [tenantId, exception.local_date, exception.is_closed, exception.start_time ?? null, exception.end_time ?? null, exception.reason?.trim() || null]);
    });
    await this.redis.client.del(this.cacheKey(tenantId)).catch(() => undefined);
    return this.get(tenantId);
  }

  async evaluate(tenantId: string, at = new Date(), includeNextOpen = false): Promise<ScheduleState> {
    const schedule = await this.get(tenantId);
    const state = evaluateSchedule(schedule, at);
    if (!state.allowed && includeNextOpen) {
      for (let minutes = 1; minutes <= 8 * 24 * 60; minutes += 1) {
        const candidate = new Date(at.getTime() + minutes * 60_000);
        if (evaluateSchedule(schedule, candidate).allowed) { state.next_open_at = candidate.toISOString(); break; }
      }
    }
    return state;
  }

  async assertAllowed(tenantId: string, at = new Date()) {
    if (this.flags && !(await this.flags.enabled(tenantId, 'schedule_enforcement'))) return { allowed: true, timezone: 'disabled', local_date: '', local_time: '', reason: 'feature_disabled' };
    const state = await this.evaluate(tenantId, at, true);
    if (!state.allowed) {
      await this.redis.incrementMetric?.('calls_blocked_schedule_total');
      await this.audit?.record({ tenantId, action: 'call.blocked_schedule', entityType: 'dialer', metadata: { reason: state.reason, localDate: state.local_date, localTime: state.local_time, timezone: state.timezone } }).catch(() => undefined);
      throw new ConflictException({ message: 'Fora do horário permitido para chamadas', code: 'outside_dialer_schedule', schedule: state });
    }
    return state;
  }
}
