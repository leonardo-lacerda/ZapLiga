import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';

describe('CampaignsService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
  };
  const service = new CampaignsService(repository as any);

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
});
