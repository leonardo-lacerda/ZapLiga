import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { BillingPage, calculatePlanTotal } from './BillingPage';

const plans = [
  {
    code: 'starter', display_name: 'Starter', included_sdrs: 2, max_sdrs: 2,
    description: 'Para equipes pequenas',
    feature_entitlements: { callbacks: 'full', operation_health: 'basic' },
    limit_entitlements: { numbers: 3, leads: 25000, retention_days: 90, max_concurrent_dialers: 1 },
    prices: [{ interval: 'month', amount: 8990, currency: 'brl' }, { interval: 'year', amount: 89900, currency: 'brl' }],
    seat_prices: [{ interval: 'month', amount: 1990, currency: 'brl' }, { interval: 'year', amount: 19900, currency: 'brl' }],
  },
  {
    code: 'growth', display_name: 'Growth', included_sdrs: 5, max_sdrs: 5,
    description: 'Para operações em crescimento',
    feature_entitlements: { campaigns: 'full' },
    limit_entitlements: { numbers: 10, leads: 250000, retention_days: 365, max_concurrent_dialers: 3 },
    prices: [{ interval: 'month', amount: 24990, currency: 'brl' }, { interval: 'year', amount: 249900, currency: 'brl' }],
    seat_prices: [{ interval: 'month', amount: 1990, currency: 'brl' }, { interval: 'year', amount: 19900, currency: 'brl' }],
  },
];

const installCatalog = (billing: Record<string, unknown> = {}) => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-a/billing', () => HttpResponse.json({
      tenantId: 'tenant-a', mode: 'read_only', reason: 'no_subscription', enforcementMode: 'enforce', usedSdrSeats: 0,
      reservedSdrSeats: 0, pendingChanges: [], subscription: null, ...billing,
    })),
    http.get('http://localhost:3000/api/tenants/tenant-a/billing/plans', () => HttpResponse.json(plans)),
  );
};

it('mostra preços, recursos e limites do catálogo sem campo global de SDRs', async () => {
  installCatalog();
  render(<BillingPage tenantId="tenant-a" />);

  expect(await screen.findByRole('heading', { name: 'Plano e cobrança' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Quantidade inicial de SDRs')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Adicionar mais SDR' })).toHaveLength(2);
  expect(screen.getByText('Callbacks')).toBeInTheDocument();
  expect(screen.queryByText(/números:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/discadores simultâneos:/)).not.toBeInTheDocument();
  expect(screen.getAllByText(/Hist.rico de m.tricas:/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Per.odo do hist.rico de m.tricas/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/R\$ 89,90/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/R\$ 249,90/).length).toBeGreaterThan(0);
});

it('começa com o teto de SDRs do plano e bloqueia novos seats acima do limite', async () => {
  installCatalog();
  const user = userEvent.setup();
  render(<BillingPage tenantId="tenant-a" />);

  const starter = (await screen.findByRole('heading', { name: 'Starter', level: 3 })).closest('article');
  expect(starter).not.toBeNull();
  expect(within(starter as HTMLElement).getByText('2 SDRs')).toBeInTheDocument();
  expect(within(starter as HTMLElement).getByRole('button', { name: 'Adicionar mais SDR' })).toBeDisabled();
  expect(within(starter as HTMLElement).getByText(/Limite deste plano atingido/)).toBeInTheDocument();
});

it('usa o preço anual do plano e respeita o limite do plano', async () => {
  installCatalog();
  const user = userEvent.setup();
  render(<BillingPage tenantId="tenant-a" />);

  await user.click(await screen.findByRole('button', { name: 'Anual' }));
  const starter = (await screen.findByRole('heading', { name: 'Starter', level: 3 })).closest('article') as HTMLElement;
  expect(within(starter).getAllByText('R$ 899,00').length).toBeGreaterThan(0);
  await user.click(within(starter).getByRole('button', { name: 'Adicionar mais SDR' }));
  expect(within(starter).getByText('2 SDRs')).toBeInTheDocument();
  expect(within(starter).getByText(/Limite deste plano atingido/)).toBeInTheDocument();
  expect(within(starter).getByRole('button', { name: 'Adicionar mais SDR' })).toBeDisabled();
});

it('envia ao checkout a quantidade de SDRs escolhida no card', async () => {
  installCatalog();
  let body: Record<string, unknown> = {};
  server.use(http.post('http://localhost:3000/api/tenants/tenant-a/billing/checkout-session', async ({ request }) => {
    body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ id: 'checkout-session' });
  }));
  const user = userEvent.setup();
  render(<BillingPage tenantId="tenant-a" />);
  const starter = (await screen.findByRole('heading', { name: 'Starter', level: 3 })).closest('article') as HTMLElement;
  await user.click(within(starter).getByRole('button', { name: /Assinar este plano/ }));
  await waitFor(() => expect(body).toMatchObject({ planCode: 'starter', interval: 'month', totalSdrSeats: 2 }));
});

it('mantém o controle de seats no teto de uma assinatura ativa', async () => {
  installCatalog({
    mode: 'full', reason: 'active_subscription', planCode: 'starter', planName: 'Starter', includedSdrs: 2,
    maxSdrs: 2, planMaxSdrs: 2, purchasedExtraSdrs: 0, usedSdrSeats: 2, reservedSdrSeats: 0,
    subscription: { status: 'active', billing_interval: 'month' },
  });
  render(<BillingPage tenantId="tenant-a" />);
  const capacity = (await screen.findByRole('heading', { name: 'Gerencie seus SDRs' })).closest('section') as HTMLElement;
  expect(within(capacity).getByText('2 SDRs')).toBeInTheDocument();
  expect(within(capacity).getByRole('button', { name: 'Adicionar mais SDR' })).toBeDisabled();
  expect(within(capacity).getByRole('button', { name: 'Salvar alteração' })).toBeDisabled();
});

it('mantém o cálculo monetário inteiro para evitar erros de ponto flutuante', () => {
  expect(calculatePlanTotal(8990, 2, 2, 1990)).toBe(8990);
  expect(calculatePlanTotal(89900, 2, 2, 19900)).toBe(89900);
});
