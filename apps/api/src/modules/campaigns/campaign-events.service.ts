import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';

type QueryExecutor = { query: (text: string, params?: unknown[]) => Promise<any> };

export type CampaignEventInput = {
  tenantId: string;
  campaignId?: string | null;
  campaignVersion?: number | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
};

@Injectable()
export class CampaignEventsService {
  constructor(private readonly db: DatabaseService) {}

  async record(input: CampaignEventInput, executor: QueryExecutor = this.db) {
    await executor.query(`INSERT INTO campaign_event_outbox
      (id, tenant_id, campaign_id, campaign_version, event_type, aggregate_type, aggregate_id, idempotency_key, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`, [
      randomUUID(), input.tenantId, input.campaignId ?? null, input.campaignVersion ?? null,
      input.eventType, input.aggregateType, input.aggregateId, input.idempotencyKey,
      JSON.stringify(input.payload ?? {}),
    ]);
  }
}
