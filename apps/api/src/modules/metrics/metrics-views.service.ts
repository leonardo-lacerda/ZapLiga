import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { SaveViewDto, UpdateViewDto } from './dto/saved-view.dto';
import { MetricsViewsRepository, SavedViewRow } from './metrics-views.repository';

export type SavedViewResponse = {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  isShared: boolean;
  ownerUserId: string;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
};

function toResponse(row: SavedViewRow): SavedViewResponse {
  return {
    id: row.id, name: row.name, filters: row.filters, isShared: row.is_shared,
    ownerUserId: row.owner_user_id, ownerName: row.owner_name ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

@Injectable()
export class MetricsViewsService {
  constructor(private readonly repo: MetricsViewsRepository, private readonly audit: AuditService) {}

  async list(tenantId: string, userId: string): Promise<SavedViewResponse[]> {
    const rows = await this.repo.list(tenantId, userId);
    return rows.map(toResponse);
  }

  async create(tenantId: string, userId: string, dto: SaveViewDto): Promise<SavedViewResponse> {
    const id = randomUUID();
    try {
      await this.repo.insert({ id, tenantId, ownerUserId: userId, name: dto.name.trim(), filters: dto.filters, isShared: Boolean(dto.isShared) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Você já tem uma visualização salva com esse nome');
      throw error;
    }
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_view.created', entityType: 'metric_saved_view', entityId: id, metadata: { name: dto.name, isShared: Boolean(dto.isShared) } });
    return toResponse((await this.repo.findById(tenantId, id))!);
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateViewDto): Promise<SavedViewResponse> {
    const current = await this.repo.findById(tenantId, id);
    if (!current) throw new NotFoundException('Visualização não encontrada');
    if (current.owner_user_id !== userId) throw new ForbiddenException('Só quem criou a visualização pode editá-la');
    try {
      await this.repo.update(tenantId, id, { name: dto.name?.trim(), filters: dto.filters, isShared: dto.isShared });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Você já tem uma visualização salva com esse nome');
      throw error;
    }
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_view.updated', entityType: 'metric_saved_view', entityId: id, metadata: { name: dto.name, isShared: dto.isShared } });
    return toResponse((await this.repo.findById(tenantId, id))!);
  }

  async remove(tenantId: string, userId: string, id: string) {
    const current = await this.repo.findById(tenantId, id);
    if (!current) throw new NotFoundException('Visualização não encontrada');
    if (current.owner_user_id !== userId) throw new ForbiddenException('Só quem criou a visualização pode excluí-la');
    await this.repo.remove(tenantId, id);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_view.deleted', entityType: 'metric_saved_view', entityId: id, metadata: { name: current.name } });
    return { ok: true, id };
  }
}
