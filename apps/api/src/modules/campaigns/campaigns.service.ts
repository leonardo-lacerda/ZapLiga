import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CAMPAIGN_STATUSES } from '../roadmap-contracts/roadmap-contracts';
import { CampaignsRepository } from './campaigns.repository';

@Injectable()
export class CampaignsService {
  constructor(private readonly campaigns: CampaignsRepository) {}

  async list(tenantId: string, query: { status?: string; limit?: string; offset?: string }) {
    const status = query.status?.trim() || undefined;
    if (status && !CAMPAIGN_STATUSES.includes(status as (typeof CAMPAIGN_STATUSES)[number])) {
      throw new BadRequestException('Status de campanha inválido');
    }
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
    return this.campaigns.list(tenantId, status, limit, offset);
  }

  async get(tenantId: string, campaignId: string) {
    const campaign = await this.campaigns.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campanha não encontrada');
    return campaign;
  }
}
