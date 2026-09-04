import { CampaignStatus, DecisionMode } from './roadmap-contracts';

export type RoadmapFixture = ReturnType<typeof createRoadmapFixture>;

export function createRoadmapFixture() {
  const tenants = [
    { id: 'tenant-roadmap-a', name: 'Operação Alfa' },
    { id: 'tenant-roadmap-b', name: 'Operação Beta' },
  ] as const;
  const campaigns: Array<{ id: string; tenantId: string; folderId: string; status: CampaignStatus; decisionMode: DecisionMode }> = [
    { id: 'campaign-a-inbound', tenantId: tenants[0].id, folderId: 'folder-a-inbound', status: 'running', decisionMode: 'shadow' },
    { id: 'campaign-b-outbound', tenantId: tenants[1].id, folderId: 'folder-b-outbound', status: 'paused', decisionMode: 'disabled' },
  ];
  const sdrs = [
    { id: 'sdr-a-1', tenantId: tenants[0].id, available: true },
    { id: 'sdr-b-1', tenantId: tenants[1].id, available: false },
  ];
  const numbers = [
    { id: 'number-a-1', tenantId: tenants[0].id, status: 'connected' },
    { id: 'number-b-1', tenantId: tenants[1].id, status: 'connected' },
  ];
  const leads = [
    { id: 'lead-a-recent', tenantId: tenants[0].id, campaignId: campaigns[0].id, folderId: campaigns[0].folderId, attempts: 0, suppressed: false },
    { id: 'lead-a-suppressed', tenantId: tenants[0].id, campaignId: campaigns[0].id, folderId: campaigns[0].folderId, attempts: 1, suppressed: true },
    { id: 'lead-b-old', tenantId: tenants[1].id, campaignId: campaigns[1].id, folderId: campaigns[1].folderId, attempts: 2, suppressed: false },
  ];
  return { tenants, campaigns, sdrs, numbers, leads };
}
