import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../billing/entitlement.service';
import { STEALTH_KILLSWITCH_MESSAGE, generateStealthProfile, parseStealthProfile, stealthCoverage, stealthKillswitchOn } from './stealth-profile';

// Login statuses, as NumbersService.list counts reconnects.
const LOGIN_STATUSES = ['connected', 'online', 'ready', 'authenticated'];

type CohortRow = {
  cohort: 'stealth' | 'control';
  lines: number;
  line_days: number;
  device_removed: number;
  account_locked: number;
  lost: number;
  median_hours_to_loss: number | null;
  lines_7d: number;
  alive_7d: number;
  lines_14d: number;
  alive_14d: number;
  calls: number;
  answered: number;
  call_acks: number;
  nacks_463: number;
  logins: number;
};

/**
 * Lines paired in the window, in two arms (docs/stealth-profile.md, "Coortes"):
 * - stealth: the switch on and paired after the profile was frozen (FULL);
 * - control: never had the switch on.
 * Lines that had it on and off, PARTIAL lines and proxy slots are left out: each mixes in another
 * variable. Each line counts from its last pairing (an earlier life ended in a loss).
 */
const COHORTS_SQL = `
  WITH lines AS (
    SELECT n.id, n.last_paired_at,
      CASE WHEN n.stealth_enabled AND n.last_paired_at >= n.stealth_profile_frozen_at THEN 'stealth'
           WHEN n.stealth_profile_frozen_at IS NULL THEN 'control' END AS cohort,
      (SELECT min(e.occurred_at) FROM number_health_events e
        WHERE e.tenant_id = n.tenant_id AND e.number_id = n.id AND e.event_type IN ('device_removed', 'account_locked')
          AND e.occurred_at >= n.last_paired_at) AS lost_at
    FROM whatsapp_numbers n
    WHERE n.tenant_id = $1 AND n.last_paired_at > now() - make_interval(days => $2) AND n.waxum_node NOT LIKE 'proxy-%'
  )
  SELECT l.cohort,
    count(*)::int AS lines,
    round((sum(extract(epoch FROM COALESCE(l.lost_at, now()) - l.last_paired_at)) / 86400.0)::numeric, 2)::float AS line_days,
    (SELECT count(*) FROM number_health_events e JOIN lines x ON x.id = e.number_id
      WHERE x.cohort = l.cohort AND e.tenant_id = $1 AND e.event_type = 'device_removed' AND e.occurred_at >= x.last_paired_at)::int AS device_removed,
    (SELECT count(*) FROM number_health_events e JOIN lines x ON x.id = e.number_id
      WHERE x.cohort = l.cohort AND e.tenant_id = $1 AND e.event_type = 'account_locked' AND e.occurred_at >= x.last_paired_at)::int AS account_locked,
    count(l.lost_at)::int AS lost,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM l.lost_at - l.last_paired_at) / 3600.0) FILTER (WHERE l.lost_at IS NOT NULL))::float AS median_hours_to_loss,
    count(*) FILTER (WHERE l.last_paired_at <= now() - interval '7 days')::int AS lines_7d,
    count(*) FILTER (WHERE l.last_paired_at <= now() - interval '7 days' AND (l.lost_at IS NULL OR l.lost_at > l.last_paired_at + interval '7 days'))::int AS alive_7d,
    count(*) FILTER (WHERE l.last_paired_at <= now() - interval '14 days')::int AS lines_14d,
    count(*) FILTER (WHERE l.last_paired_at <= now() - interval '14 days' AND (l.lost_at IS NULL OR l.lost_at > l.last_paired_at + interval '14 days'))::int AS alive_14d,
    (SELECT count(*) FROM calls c JOIN lines x ON x.id = c.number_id
      WHERE x.cohort = l.cohort AND c.tenant_id = $1 AND NOT c.canary AND c.created_at >= x.last_paired_at)::int AS calls,
    (SELECT count(*) FROM calls c JOIN lines x ON x.id = c.number_id
      WHERE x.cohort = l.cohort AND c.tenant_id = $1 AND NOT c.canary AND c.created_at >= x.last_paired_at AND c.connected_at IS NOT NULL)::int AS answered,
    (SELECT count(*) FROM call_signal_events s JOIN lines x ON x.id = s.number_id
      WHERE x.cohort = l.cohort AND s.tenant_id = $1 AND s.kind = 'call_ack' AND s.received_at >= x.last_paired_at)::int AS call_acks,
    (SELECT count(*) FROM call_signal_events s JOIN lines x ON x.id = s.number_id
      WHERE x.cohort = l.cohort AND s.tenant_id = $1 AND s.kind = 'call_ack' AND s.detail->>'error' = '463' AND s.received_at >= x.last_paired_at)::int AS nacks_463,
    (SELECT count(*) FROM number_status_history h JOIN lines x ON x.id = h.number_id
      WHERE x.cohort = l.cohort AND h.tenant_id = $1 AND lower(h.to_status) = ANY($3::text[]) AND h.changed_at >= x.last_paired_at)::int AS logins
  FROM lines l
  WHERE l.cohort IS NOT NULL
  GROUP BY l.cohort
  ORDER BY l.cohort DESC
`;

const per100 = (count: number, base: number) => (base > 0 ? Math.round((count / base) * 10_000) / 100 : null);

/**
 * Camouflage per line (docs/stealth-profile.md): the switch of each line and the comparison of
 * the lines with it against the lines without it.
 */
@Injectable()
export class StealthService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly entitlement: EntitlementService) {}

  /**
   * The first time the switch goes on the profile is generated and frozen; turning it on again
   * reuses it. Takes effect on the line's next login (its next QR or code for the registration
   * part): a live session is never touched.
   */
  async setEnabled(tenantId: string, actorUserId: string, id: string, enabled: boolean) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    if (enabled && stealthKillswitchOn()) throw new BadRequestException(STEALTH_KILLSWITCH_MESSAGE);
    const line = (await this.db.query("SELECT * FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2 AND status <> 'removed'", [id, tenantId])).rows[0];
    if (!line) throw new NotFoundException('Número não encontrado');
    if (enabled) await this.assertGeelarkPhoneFree(id);
    const profile = line.stealth_profile ? parseStealthProfile(line.stealth_profile) : enabled ? generateStealthProfile(id) : null;
    const result = await this.db.query(`
      UPDATE whatsapp_numbers SET stealth_enabled = $3, stealth_profile = $4::jsonb,
        stealth_profile_frozen_at = COALESCE(stealth_profile_frozen_at, CASE WHEN $3 THEN now() END)
      WHERE id = $1 AND tenant_id = $2 RETURNING *
    `, [id, tenantId, enabled, profile ? JSON.stringify(profile) : null]);
    const row = result.rows[0];
    await this.audit.record({ actorUserId, tenantId, action: 'number.stealth_changed', entityType: 'whatsapp_number', entityId: id, metadata: { enabled, profile } });
    return { ...row, stealth_coverage: stealthCoverage(row) };
  }

  // A GeeLark phone hosts at most one camouflaged line (its WhatsApp and its WhatsApp Business).
  private async assertGeelarkPhoneFree(id: string) {
    const other = (await this.db.query(`
      SELECT n.label FROM provisioning_jobs mine
      JOIN provisioning_jobs other ON other.geelark_phone_id = mine.geelark_phone_id
      JOIN whatsapp_numbers n ON n.id = other.number_id AND n.id <> $1 AND n.stealth_enabled AND n.status <> 'removed'
      WHERE mine.number_id = $1 LIMIT 1
    `, [id])).rows[0];
    if (other) throw new ConflictException(`O celular GeeLark desta linha já tem outra linha com camuflagem (${other.label}).`);
  }

  async cohorts(tenantId: string, days: number) {
    const rows = (await this.db.query(COHORTS_SQL, [tenantId, days, LOGIN_STATUSES])).rows as CohortRow[];
    return {
      days,
      killswitch: stealthKillswitchOn(),
      cohorts: rows.map((row) => ({
        ...row,
        losses_per_100_line_days: per100(row.device_removed + row.account_locked, row.line_days),
        losses_per_100_calls: per100(row.device_removed + row.account_locked, row.calls),
        nacks_463_per_100_calls: per100(row.nacks_463, row.calls),
        logins_per_line_day: row.line_days > 0 ? Math.round((row.logins / row.line_days) * 100) / 100 : null,
      })),
    };
  }
}
