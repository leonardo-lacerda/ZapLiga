import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { BillingPage } from './BillingPage';

it('mostra preços, recursos e limites do catálogo para uma organização sem plano', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-a/billing', () => HttpResponse.json({
      tenantId: 'tenant-a',
      mode: 'read_only',
      reason: 'no_subscription',
      enforcementMode: 'enforce',
      usedSdrSeats: 0,
      reservedSdrSeats: 0,
      pendingChanges: [],
      subscription: null,
    })),
    http.get('http://localhost:3000/api/tenants/tenant-a/billing/plans', () => HttpResponse.json([
      {
        code: 'starter', display_name: 'Starter', included_sdrs: 5, max_sdrs: 14,
        description: 'Para equipes pequenas',
        feature_entitlements: { callbacks: 'full', operation_health: 'basic' },
        limit_entitlements: { numbers: 3, leads: 25000 },
        prices: [{ interval: 'month', amount: 8990, currency: 'brl' }, { interval: 'year', amount: 89900, currency: 'brl' }],
      },
      {
        code: 'growth', display_name: 'Growth', included_sdrs: 15, max_sdrs: 39,
        description: 'Para operações em crescimento',
        feature_entitlements: { campaigns: 'full' },
        limit_entitlements: { numbers: 10, leads: 250000 },
        prices: [{ interval: 'month', amount: 24990, currency: 'brl' }],
      },
    ])),
  );

  render(<BillingPage tenantId="tenant-a" />);

  expect(await screen.findByText('Starter')).toBeInTheDocument();
  expect((await screen.findAllByText(/89,90/)).length).toBeGreaterThan(0);
  expect(screen.getByText('Callbacks')).toBeInTheDocument();
  expect(screen.getByText(/n[uú]meros: 3/)).toBeInTheDocument();
  expect(screen.getByText('Growth')).toBeInTheDocument();
  expect(screen.getAllByText(/249,90/).length).toBeGreaterThan(0);
});
