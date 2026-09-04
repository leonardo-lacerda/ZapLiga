import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';

describe('CampaignsService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
    findForUpdate: jest.fn(),
    definition: jest.fn(),
    resourceOwnership: jest.fn(),
    updateDraft: jest.fn(),
    replaceAssociations: jest.fn(),
    insertVersion: jest.fn(),
    publish: jest.fn(),
    transition: jest.fn(),
  };
  const client = { query: jest.fn() };
  const db = { transaction: jest.fn(async (callback: any) => callback(client)) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new CampaignsService(repository as any, db as any, audit as any);

  beforeEach(() => jest.clearAllMocks());

  it('normalizes pagination and forwards the tenant scope', async () => {
    repository.list.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });

    await service.list('tenant-a', { status: 'running', limit: '999', offset: '-5' });

    expect(repository.list).toHaveBeenCalledWith('tenant-a', 'running', 100, 0);
  });

  it('rejects unknown campaign statuses before querying the repository', async () => {
    await expect(service.list('tenant-a', { status: 'executing' })).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('returns not found instead of leaking a campaign from another tenant', async () => {
    repository.findById.mockResolvedValue(undefined);

    await expect(service.get('tenant-b', 'campaign-from-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findById).toHaveBeenCalledWith('tenant-b', 'campaign-from-a');
  });

  it('rejects a stale lock before writing concurrent changes', async () => {
    repository.findForUpdate.mockResolvedValue({ id: 'campaign-1', status: 'draft', is_legacy: false, lock_version: 2 });

    await expect(service.update('tenant-a', 'campaign-1', 'leader-1', {
      expectedLockVersion: 1,
      name: 'Mudança concorrente',
    })).rejects.toBeInstanceOf(ConflictException);

    expect(repository.updateDraft).not.toHaveBeenCalled();
  });

  it('rejects an invalid state transition', async () => {
    repository.findForUpdate.mockResolvedValue({ id: 'campaign-1', status: 'draft', is_legacy: false, lock_version: 0, current_version: null });

    await expect(service.start('tenant-a', 'campaign-1', 'leader-1', { expectedLockVersion: 0 })).rejects.toBeInstanceOf(ConflictException);
    expect(repository.transition).not.toHaveBeenCalled();
  });

  it('publishes a new immutable version when editing a running campaign', async () => {
    repository.findForUpdate.mockResolvedValue({ id: 'campaign-1', status: 'running', is_legacy: false, lock_version: 0, current_version: 1 });
    repository.definition.mockResolvedValue({
      id: 'campaign-1', name: 'Campanha A', description: null, folder_id: 'folder-1',
      primary_goal_metric: null, primary_goal_target: null, is_legacy: false,
      draft_config: { queueStrategy: 'fifo' }, sdr_ids: ['sdr-1'], number_ids: ['number-1'],
    });
    repository.resourceOwnership.mockResolvedValue({ folder_exists: true, sdr_count: 1, number_count: 1 });
    repository.updateDraft.mockResolvedValue({ lock_version: 1 });
    repository.replaceAssociations.mockResolvedValue(undefined);
    repository.insertVersion.mockResolvedValue(undefined);
    repository.publish.mockResolvedValue({ current_version: 2 });
    repository.findById.mockResolvedValue({ id: 'campaign-1', current_version: 2, status: 'running' });

    const result = await service.update('tenant-a', 'campaign-1', 'leader-1', {
      expectedLockVersion: 0,
      name: 'Campanha A revisada',
      changeReason: 'Ajuste de abordagem',
    });

    expect(result.current_version).toBe(2);
    expect(repository.insertVersion).toHaveBeenCalledWith(client, expect.objectContaining({ version: 2, reason: 'Ajuste de abordagem', lockVersion: 1 }));
    expect(repository.publish).toHaveBeenCalledWith(client, 'tenant-a', 'campaign-1', 2, 'leader-1', false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'campaign.version_published' }), client);
  });
});
