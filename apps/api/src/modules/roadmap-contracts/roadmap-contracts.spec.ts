import {
  CAMPAIGN_STATUSES,
  DECISION_MODES,
  OPERATION_HEALTH_STATES,
  RECOMMENDATION_SEVERITIES,
  RECOMMENDATION_STATUSES,
  ROADMAP_EVENT_TYPES,
  ROADMAP_REASON_CODES,
} from './roadmap-contracts';
import { createRoadmapFixture } from './roadmap-fixtures';

const expectUnique = (values: readonly string[]) => expect(new Set(values).size).toBe(values.length);

describe('roadmap contracts', () => {
  it('keeps every canonical catalog unique and machine-readable', () => {
    for (const catalog of [CAMPAIGN_STATUSES, DECISION_MODES, OPERATION_HEALTH_STATES, RECOMMENDATION_SEVERITIES, RECOMMENDATION_STATUSES, ROADMAP_REASON_CODES]) {
      expectUnique(catalog);
      for (const value of catalog) expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expectUnique(ROADMAP_EVENT_TYPES);
    for (const value of ROADMAP_EVENT_TYPES) expect(value).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
  });

  it('provides two isolated tenants with campaigns, lines, SDRs and leads', () => {
    const fixture = createRoadmapFixture();
    expect(fixture.tenants).toHaveLength(2);
    for (const campaign of fixture.campaigns) expect(fixture.tenants.some((tenant) => tenant.id === campaign.tenantId)).toBe(true);
    for (const lead of fixture.leads) {
      const campaign = fixture.campaigns.find((item) => item.id === lead.campaignId);
      expect(campaign?.tenantId).toBe(lead.tenantId);
      expect(campaign?.folderId).toBe(lead.folderId);
    }
    for (const resource of [...fixture.sdrs, ...fixture.numbers]) expect(fixture.tenants.some((tenant) => tenant.id === resource.tenantId)).toBe(true);
  });
});
