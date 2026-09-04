import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { CAMPAIGN_STATUSES } from '../roadmap-contracts/roadmap-contracts';
import { CampaignTransitionDto, CreateCampaignDto, DuplicateCampaignDto, UpdateCampaignDto } from './campaigns.dto';
import { CampaignConfig, CampaignDefinition, canonicalizeCampaignSnapshot, diffCampaignSnapshots, hashCampaignSnapshot, validateCampaignDefinition } from './campaigns.domain';
import { CampaignsRepository } from './campaigns.repository';
import { CampaignEventsService } from './campaign-events.service';
import { CreateCampaignPlaybookDto, InstantiateCampaignPlaybookDto } from './campaign-playbooks.dto';

type CampaignRow = Record<string, any>;

const legacyConfig = (snapshot: Record<string, any>): CampaignConfig => {
  const settings = snapshot.dialer_settings ?? {};
  return {
    queueStrategy: settings.queue_strategy,
    maxAttemptsPerLead: settings.max_attempts_per_lead,
    retryDelayMinutes: settings.retry_delay_minutes,
    maxCallsPerMinute: settings.max_calls_per_minute,
    minSecondsBetweenCalls: settings.min_seconds_between_calls,
    timezone: snapshot.timezone,
    scheduleWindows: (snapshot.schedule_windows ?? []).map((window: Record<string, any>) => ({
      dayOfWeek: Number(window.day_of_week), startTime: String(window.start_time).slice(0, 5), endTime: String(window.end_time).slice(0, 5),
    })),
  };
};

const definitionFromRow = (row: CampaignRow): CampaignDefinition => ({
  name: String(row.name ?? '').trim(),
  description: row.description ?? null,
  folderId: row.folder_id ?? '',
  primaryGoalMetric: row.primary_goal_metric ?? null,
  primaryGoalTarget: row.primary_goal_target == null ? null : Number(row.primary_goal_target),
  sdrIds: [...(row.sdr_ids ?? [])].map(String).sort(),
  numberIds: [...(row.number_ids ?? [])].map(String).sort(),
  config: row.is_legacy ? legacyConfig(row.published_config ?? row.draft_config ?? {}) : (row.draft_config ?? {}),
});

const snapshotFromDefinition = (definition: CampaignDefinition) => canonicalizeCampaignSnapshot({
  schema_version: 1,
  campaign: {
    name: definition.name, description: definition.description ?? null, folder_id: definition.folderId,
    primary_goal_metric: definition.primaryGoalMetric ?? null, primary_goal_target: definition.primaryGoalTarget ?? null,
  },
  rules: definition.config,
  sdr_ids: [...definition.sdrIds].sort(),
  number_ids: [...definition.numberIds].sort(),
});

const definitionFromSnapshot = (snapshot: any): CampaignDefinition => ({
  name: String(snapshot?.campaign?.name ?? 'Campanha do playbook'),
  description: snapshot?.campaign?.description ?? null,
  folderId: String(snapshot?.campaign?.folder_id ?? ''),
  primaryGoalMetric: snapshot?.campaign?.primary_goal_metric ?? null,
  primaryGoalTarget: snapshot?.campaign?.primary_goal_target == null ? null : Number(snapshot.campaign.primary_goal_target),
  sdrIds: Array.isArray(snapshot?.sdr_ids) ? snapshot.sdr_ids.map(String) : [],
  numberIds: Array.isArray(snapshot?.number_ids) ? snapshot.number_ids.map(String) : [],
  config: (snapshot?.rules ?? {}) as CampaignConfig,
});

@Injectable()
export class CampaignsService {
  constructor(
    private readonly campaigns: CampaignsRepository,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Optional() private readonly events?: CampaignEventsService,
  ) {}

  async list(tenantId: string, query: { status?: string; limit?: string; offset?: string }) {
    const status = query.status?.trim() || undefined;
    if (status && !CAMPAIGN_STATUSES.includes(status as (typeof CAMPAIGN_STATUSES)[number])) throw new BadRequestException('Status de campanha inválido');
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
    return this.campaigns.list(tenantId, status, limit, offset);
  }

  async get(tenantId: string, campaignId: string) {
    const campaign = await this.campaigns.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campanha não encontrada');
    return campaign;
  }

  private validate(definition: CampaignDefinition, forPublish: boolean) {
    const issues = validateCampaignDefinition(definition, forPublish);
    if (issues.length) throw new BadRequestException({ code: 'campaign_invalid', message: 'Revise a configuração da campanha', issues });
  }

  private async assertOwnership(client: PoolClient, tenantId: string, definition: CampaignDefinition) {
    const scope = await this.campaigns.resourceOwnership(client, tenantId, definition.folderId, definition.sdrIds, definition.numberIds);
    const issues: Array<{ code: string; path: string; message: string }> = [];
    if (!scope?.folder_exists) issues.push({ code: 'campaign_folder_cross_tenant', path: 'folderId', message: 'Pasta inexistente neste tenant' });
    if (Number(scope?.sdr_count ?? 0) !== definition.sdrIds.length) issues.push({ code: 'campaign_sdr_cross_tenant', path: 'sdrIds', message: 'Um ou mais SDRs não pertencem ao tenant' });
    if (Number(scope?.number_count ?? 0) !== definition.numberIds.length) issues.push({ code: 'campaign_number_cross_tenant', path: 'numberIds', message: 'Uma ou mais linhas não pertencem ao tenant' });
    if (issues.length) throw new BadRequestException({ code: 'campaign_resource_scope_invalid', message: 'A campanha contém recursos inválidos', issues });
  }

  private assertEditable(row: CampaignRow) {
    if (!row) throw new NotFoundException('Campanha não encontrada');
    if (row.is_legacy) throw new ConflictException({ code: 'campaign_legacy_read_only', message: 'Duplique a campanha legada para editar' });
    if (['completed', 'archived'].includes(row.status)) throw new ConflictException({ code: 'campaign_terminal_state', message: 'Campanha concluída ou arquivada não pode ser editada' });
  }

  private assertLock(row: CampaignRow, expected: number) {
    if (Number(row.lock_version) !== Number(expected)) throw new ConflictException({ code: 'campaign_version_conflict', message: 'A campanha foi alterada por outra sessão', currentLockVersion: Number(row.lock_version) });
  }

  private createDefinition(input: CreateCampaignDto): CampaignDefinition {
    return {
      name: input.name.trim(), description: input.description?.trim() || null, folderId: input.folderId,
      primaryGoalMetric: input.primaryGoalMetric?.trim() || null, primaryGoalTarget: input.primaryGoalTarget ?? null,
      sdrIds: [...input.sdrIds].sort(), numberIds: [...input.numberIds].sort(), config: input.config as CampaignConfig,
    };
  }

  async create(tenantId: string, userId: string, input: CreateCampaignDto) {
    const definition = this.createDefinition(input);
    this.validate(definition, false);
    const campaignId = randomUUID();
    try {
      await this.db.transaction(async (client) => {
        await this.assertOwnership(client, tenantId, definition);
        await this.campaigns.createDraft(client, { id: campaignId, tenantId, userId, name: definition.name,
          description: definition.description, folderId: definition.folderId, primaryGoalMetric: definition.primaryGoalMetric,
          primaryGoalTarget: definition.primaryGoalTarget, config: definition.config as Record<string, unknown> });
        await this.campaigns.replaceAssociations(client, tenantId, campaignId, definition.sdrIds, definition.numberIds);
        await this.audit.record({ actorUserId: userId, tenantId, action: 'campaign.created', entityType: 'campaign', entityId: campaignId }, client as any);
        await this.events?.record({ tenantId, campaignId, eventType: 'campaign.created', aggregateType: 'campaign', aggregateId: campaignId, idempotencyKey: `campaign.created:${campaignId}`, payload: { name: definition.name } }, client as any);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Já existe uma campanha com este nome');
      throw error;
    }
    return this.get(tenantId, campaignId);
  }

  async update(tenantId: string, campaignId: string, userId: string, input: UpdateCampaignDto) {
    await this.db.transaction(async (client) => {
      const row = await this.campaigns.findForUpdate(client, tenantId, campaignId);
      this.assertEditable(row);
      this.assertLock(row, input.expectedLockVersion);
      const current = definitionFromRow(await this.campaigns.definition(client, tenantId, campaignId));
      const definition: CampaignDefinition = {
        name: input.name === undefined ? current.name : input.name.trim(),
        description: input.description === undefined ? current.description : input.description.trim() || null,
        folderId: input.folderId ?? current.folderId,
        primaryGoalMetric: input.primaryGoalMetric === undefined ? current.primaryGoalMetric : input.primaryGoalMetric.trim() || null,
        primaryGoalTarget: input.primaryGoalTarget === undefined ? current.primaryGoalTarget : input.primaryGoalTarget,
        sdrIds: input.sdrIds === undefined ? current.sdrIds : [...input.sdrIds].sort(),
        numberIds: input.numberIds === undefined ? current.numberIds : [...input.numberIds].sort(),
        config: input.config === undefined ? current.config : input.config as CampaignConfig,
      };
      this.validate(definition, row.status === 'running');
      await this.assertOwnership(client, tenantId, definition);
      const updated = await this.campaigns.updateDraft(client, tenantId, campaignId, {
        ...definition, config: definition.config as Record<string, unknown>, status: row.status === 'running' ? 'running' : 'draft', userId,
      });
      await this.campaigns.replaceAssociations(client, tenantId, campaignId, definition.sdrIds, definition.numberIds);
      await this.audit.record({ actorUserId: userId, tenantId, action: 'campaign.updated', entityType: 'campaign', entityId: campaignId,
        metadata: { changed: Object.keys(input).filter((key) => key !== 'expectedLockVersion'), lockVersion: updated.lock_version } }, client as any);
      await this.events?.record({ tenantId, campaignId, campaignVersion: row.current_version ?? null, eventType: 'campaign.updated', aggregateType: 'campaign', aggregateId: campaignId, idempotencyKey: `campaign.updated:${campaignId}:${updated.lock_version}`, payload: { lockVersion: updated.lock_version } }, client as any);

      if (row.status === 'running') {
        const version = Number(row.current_version ?? 0) + 1;
        const snapshot = snapshotFromDefinition(definition);
        await this.campaigns.insertVersion(client, { id: randomUUID(), tenantId, campaignId, version, snapshot,
          hash: hashCampaignSnapshot(snapshot), reason: input.changeReason ?? 'Edição durante execução', userId, lockVersion: Number(updated.lock_version) });
        await this.campaigns.publish(client, tenantId, campaignId, version, userId, false);
        await this.events?.record({ tenantId, campaignId, campaignVersion: version, eventType: 'campaign.version_published', aggregateType: 'campaign', aggregateId: campaignId, idempotencyKey: `campaign.version_published:${campaignId}:${version}`, payload: { reason: 'running_campaign_edit' } }, client as any);
        await this.audit.record({ actorUserId: userId, tenantId, action: 'campaign.version_published', entityType: 'campaign', entityId: campaignId,
          metadata: { version, reason: input.changeReason ?? 'Edição durante execução' } }, client as any);
      }
    });
    return this.get(tenantId, campaignId);
  }

  async publish(tenantId: string, campaignId: string, userId: string, input: CampaignTransitionDto) {
    await this.db.transaction(async (client) => {
      const row = await this.campaigns.findForUpdate(client, tenantId, campaignId);
      this.assertEditable(row);
      this.assertLock(row, input.expectedLockVersion);
      if (row.status !== 'draft') throw new ConflictException({ code: 'campaign_transition_invalid', message: 'Somente rascunhos podem ser publicados' });
      const definition = definitionFromRow(await this.campaigns.definition(client, tenantId, campaignId));
      this.validate(definition, true);
      await this.assertOwnership(client, tenantId, definition);
      const version = Number(row.current_version ?? 0) + 1;
      const snapshot = snapshotFromDefinition(definition);
      await this.campaigns.insertVersion(client, { id: randomUUID(), tenantId, campaignId, version, snapshot,
        hash: hashCampaignSnapshot(snapshot), reason: input.reason ?? 'Publicação', userId, lockVersion: Number(row.lock_version) });
      await this.campaigns.publish(client, tenantId, campaignId, version, userId, true);
      await this.audit.record({ actorUserId: userId, tenantId, action: 'campaign.version_published', entityType: 'campaign', entityId: campaignId,
        metadata: { version, reason: input.reason ?? null } }, client as any);
      await this.events?.record({ tenantId, campaignId, campaignVersion: version, eventType: 'campaign.version_published', aggregateType: 'campaign', aggregateId: campaignId, idempotencyKey: `campaign.version_published:${campaignId}:${version}`, payload: { reason: input.reason ?? null } }, client as any);
    });
    return this.get(tenantId, campaignId);
  }

  private async changeStatus(tenantId: string, campaignId: string, userId: string, input: CampaignTransitionDto, target: string, allowed: string[], action: string) {
    await this.db.transaction(async (client) => {
      const row = await this.campaigns.findForUpdate(client, tenantId, campaignId);
      if (!row) throw new NotFoundException('Campanha não encontrada');
      if (row.is_legacy) throw new ConflictException({ code: 'campaign_legacy_read_only', message: 'Duplique a campanha legada para alterar seu estado' });
      if (row.status === 'archived') throw new ConflictException({ code: 'campaign_terminal_state', message: 'Campanha arquivada não pode mudar de estado' });
      this.assertLock(row, input.expectedLockVersion);
      if (!allowed.includes(row.status) || (target === 'running' && !row.current_version)) {
        throw new ConflictException({ code: 'campaign_transition_invalid', message: `Transição ${row.status} → ${target} não permitida` });
      }
      await this.campaigns.transition(client, tenantId, campaignId, target, userId);
      await this.audit.record({ actorUserId: userId, tenantId, action, entityType: 'campaign', entityId: campaignId,
        metadata: { from: row.status, to: target, reason: input.reason ?? null } }, client as any);
      await this.events?.record({ tenantId, campaignId, campaignVersion: row.current_version ?? null, eventType: action, aggregateType: 'campaign', aggregateId: campaignId, idempotencyKey: `${action}:${campaignId}:${Number(row.lock_version) + 1}`, payload: { from: row.status, to: target, reason: input.reason ?? null } }, client as any);
    });
    return this.get(tenantId, campaignId);
  }

  start(tenantId: string, campaignId: string, userId: string, input: CampaignTransitionDto) { return this.changeStatus(tenantId, campaignId, userId, input, 'running', ['ready', 'paused'], 'campaign.started'); }
  pause(tenantId: string, campaignId: string, userId: string, input: CampaignTransitionDto) { return this.changeStatus(tenantId, campaignId, userId, input, 'paused', ['running'], 'campaign.paused'); }
  complete(tenantId: string, campaignId: string, userId: string, input: CampaignTransitionDto) { return this.changeStatus(tenantId, campaignId, userId, input, 'completed', ['running', 'paused'], 'campaign.completed'); }
  archive(tenantId: string, campaignId: string, userId: string, input: CampaignTransitionDto) { return this.changeStatus(tenantId, campaignId, userId, input, 'archived', ['draft', 'ready', 'paused', 'completed'], 'campaign.archived'); }

  async duplicate(tenantId: string, campaignId: string, userId: string, input: DuplicateCampaignDto) {
    const duplicateId = randomUUID();
    try {
      await this.db.transaction(async (client) => {
        const row = await this.campaigns.findForUpdate(client, tenantId, campaignId);
        if (!row) throw new NotFoundException('Campanha não encontrada');
        const definition = definitionFromRow(await this.campaigns.definition(client, tenantId, campaignId));
        if (!definition.folderId) definition.folderId = await this.campaigns.findDefaultFolderId(client, tenantId) ?? '';
        definition.name = input.name?.trim() || `${definition.name} (cópia)`;
        this.validate(definition, false);
        await this.assertOwnership(client, tenantId, definition);
        await this.campaigns.createDraft(client, { id: duplicateId, tenantId, userId, name: definition.name,
          description: definition.description, folderId: definition.folderId, primaryGoalMetric: definition.primaryGoalMetric,
          primaryGoalTarget: definition.primaryGoalTarget, config: definition.config as Record<string, unknown> });
        await this.campaigns.replaceAssociations(client, tenantId, duplicateId, definition.sdrIds, definition.numberIds);
        await this.audit.record({ actorUserId: userId, tenantId, action: 'campaign.created', entityType: 'campaign', entityId: duplicateId,
          metadata: { duplicatedFrom: campaignId } }, client as any);
        await this.events?.record({ tenantId, campaignId: duplicateId, eventType: 'campaign.created', aggregateType: 'campaign', aggregateId: duplicateId, idempotencyKey: `campaign.created:${duplicateId}`, payload: { duplicatedFrom: campaignId } }, client as any);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Já existe uma campanha com este nome');
      throw error;
    }
    return this.get(tenantId, duplicateId);
  }

  async versions(tenantId: string, campaignId: string) {
    await this.get(tenantId, campaignId);
    return this.campaigns.listVersions(tenantId, campaignId);
  }

  async version(tenantId: string, campaignId: string, version: number) {
    await this.get(tenantId, campaignId);
    const result = await this.campaigns.findVersion(tenantId, campaignId, version);
    if (!result) throw new NotFoundException('Versão da campanha não encontrada');
    return result;
  }

  async diff(tenantId: string, campaignId: string, from: number, to: number) {
    const [before, after] = await Promise.all([this.version(tenantId, campaignId, from), this.version(tenantId, campaignId, to)]);
    return { from, to, changes: diffCampaignSnapshots(before.config_snapshot, after.config_snapshot) };
  }

  async listPlaybooks(tenantId: string) {
    return this.campaigns.listPlaybooks(tenantId);
  }

  async savePlaybook(tenantId: string, campaignId: string, userId: string, input: CreateCampaignPlaybookDto) {
    const playbookId = randomUUID();
    try {
      await this.db.transaction(async (client) => {
        const row = await this.campaigns.findForUpdate(client, tenantId, campaignId);
        if (!row) throw new NotFoundException('Campanha nÃ£o encontrada');
        const definition = definitionFromRow(await this.campaigns.definition(client, tenantId, campaignId));
        this.validate(definition, false);
        const snapshot = snapshotFromDefinition(definition);
        await this.campaigns.createPlaybook(client, {
          id: playbookId,
          tenantId,
          name: input.name?.trim() || `${definition.name} (playbook)`,
          description: input.description?.trim() || definition.description,
          sourceCampaignId: campaignId,
          snapshot,
          hash: hashCampaignSnapshot(snapshot),
          userId,
        });
        await this.audit.record({ actorUserId: userId, tenantId, action: 'campaign.playbook_created', entityType: 'campaign_playbook', entityId: playbookId, metadata: { sourceCampaignId: campaignId } }, client as any);
        await this.events?.record({ tenantId, campaignId, campaignVersion: row.current_version ?? null, eventType: 'campaign.playbook_created', aggregateType: 'campaign_playbook', aggregateId: playbookId, idempotencyKey: `campaign.playbook_created:${playbookId}`, payload: { sourceCampaignId: campaignId } }, client as any);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('JÃ¡ existe um playbook com este nome');
      throw error;
    }
    return this.campaigns.findPlaybook(tenantId, playbookId);
  }

  async instantiatePlaybook(tenantId: string, playbookId: string, userId: string, input: InstantiateCampaignPlaybookDto) {
    const playbook = await this.campaigns.findPlaybook(tenantId, playbookId);
    if (!playbook) throw new NotFoundException('Playbook nÃ£o encontrado');
    const definition = definitionFromSnapshot(playbook.config_snapshot);
    return this.create(tenantId, userId, {
      name: input.name?.trim() || `${definition.name} (nova)`,
      description: definition.description ?? undefined,
      folderId: definition.folderId,
      primaryGoalMetric: definition.primaryGoalMetric ?? undefined,
      primaryGoalTarget: definition.primaryGoalTarget ?? undefined,
      sdrIds: definition.sdrIds,
      numberIds: definition.numberIds,
      config: definition.config as Record<string, unknown>,
    });
  }
}
