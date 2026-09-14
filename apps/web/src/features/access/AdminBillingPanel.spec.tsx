import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { AdminBillingPanel } from './AdminBillingPanel';

const plans = [{
  code: 'starter', display_name: 'Starter', included_sdrs: 2, max_sdrs: 2,
  prices: [{ interval: 'month', amount: 8990, currency: 'brl' }],
  seat_prices: [{ interval: 'month', amount: 1990, currency: 'brl' }],
}, {
  code: 'growth', display_name: 'Growth', included_sdrs: 5, max_sdrs: 5,
  prices: [{ interval: 'month', amount: 24990, currency: 'brl' }],
  seat_prices: [{ interval: 'month', amount: 1990, currency: 'brl' }],
}];

const install = (billing: Record<string, unknown> = {}) => {
  server.use(
    http.get('http://localhost:3000/api/admin/tenants/tenant-a/billing', () => HttpResponse.json({
      tenantId: 'tenant-a', stripeConfigured: true, mode: 'read_only', reason: 'no_subscription',
      usedSdrSeats: 0, reservedSdrSeats: 0, totalSdrSeats: null, pendingChanges: [], subscription: null, ...billing,
    })),
    http.get('http://localhost:3000/api/admin/tenants/tenant-a/billing/plans', () => HttpResponse.json(plans)),
  );
};

it('gera checkout administrativo com plano e quantidade de SDRs selecionados', async () => {
  install();
  const checkoutBody: Record<string, unknown> = {};
  server.use(
    http.post('http://localhost:3000/api/admin/tenants/tenant-a/billing/preview', () => HttpResponse.json({ mode: 'checkout', targetTotalSeats: 5, effectiveAt: 'after_payment', price: { amount: 24990, currency: 'brl' } })),
    http.post('http://localhost:3000/api/admin/tenants/tenant-a/billing/checkout-session', async ({ request }) => { Object.assign(checkoutBody, await request.json()); return HttpResponse.json({ url: 'https://checkout.stripe.test/session' }); }),
  );
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<AdminBillingPanel tenantId="tenant-a" />);

  await screen.findByText('Nenhum plano');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Plano' }), 'growth');
  await user.type(screen.getByPlaceholderText('Ex.: upgrade solicitado pelo cliente'), 'Ativação comercial');
  await user.click(screen.getByRole('button', { name: 'Gerar checkout' }));

  await waitFor(() => expect(checkoutBody).toMatchObject({ planCode: 'growth', interval: 'month', totalSdrSeats: 5 }));
  expect(await screen.findByText('Checkout aguardando pagamento')).toBeInTheDocument();
  vi.restoreAllMocks();
});

it('respeita o teto de SDRs de uma assinatura ativa', async () => {
  install({ mode: 'full', reason: 'active_subscription', planCode: 'starter', planName: 'Starter', includedSdrs: 2, maxSdrs: 2, totalSdrSeats: 2, planMaxSdrs: 2, usedSdrSeats: 2, subscription: { status: 'active', billing_interval: 'month' }, customer: { stripe_customer_id: 'cus_1' } });
  render(<AdminBillingPanel tenantId="tenant-a" />);
  expect(await screen.findByText('Starter')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Adicionar SDR' })).toBeDisabled();
});
