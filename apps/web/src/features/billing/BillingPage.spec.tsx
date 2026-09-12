import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { BillingPage, calculatePlanTotal } from './BillingPage';

const plans = [
  {
    code: 'starter', display_name: 'Starter', included_sdrs: 5, max_sdrs: 14,
    description: 'Para equipes pequenas',
    feature_entitlements: { callbacks: 'full', operation_health: 'basic' },
    limit_entitlements: { numbers: 3, leads: 25000 },
    prices: [{ interval: 'month', amount: 8990, currency: 'brl' }, { interval: 'year', amount: 89900, currency: 'brl' }],
    seat_prices: [{ interval: 'month', amount: 1990, currency: 'brl' }, { interval: 'year', amount: 19900, currency: 'brl' }],
  },
  {
    code: 'growth', display_name: 'Growth', included_sdrs: 15, max_sdrs: 39,
    description: 'Para operações em crescimento',
    feature_entitlements: { campaigns: 'full' },
    limit_entitlements: { numbers: 10, leads: 250000 },
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
  expect(screen.getAllByText(/números:/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/R\$ 89,90/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/R\$ 249,90/).length).toBeGreaterThan(0);
});

it('começa com os SDRs incluídos e recalcula o valor a cada adicional', async () => {
  installCatalog();
  const user = userEvent.setup();
  render(<BillingPage tenantId="tenant-a" />);

  const starter = (await screen.findByRole('heading', { name: 'Starter', level: 3 })).closest('article');
  expect(starter).not.toBeNull();
  expect(within(starter as HTMLElement).getByText('5 SDRs')).toBeInTheDocument();
  await user.click(within(starter as HTMLElement).getByRole('button', { name: 'Adicionar mais SDR' }));
  expect(within(starter as HTMLElement).getByText('6 SDRs')).toBeInTheDocument();
  expect(within(starter as HTMLElement).getByText('R$ 109,80')).toBeInTheDocument();
  expect(screen.getByText('6 SDRs · 1 adicional')).toBeInTheDocument();
});

it('usa o preço anual do adicional e respeita o limite do plano', async () => {
  installCatalog();
  const user = userEvent.setup();
  render(<BillingPage tenantId="tenant-a" />);

  await user.click(await screen.findByRole('button', { name: 'Anual' }));
  const starter = (await screen.findByRole('heading', { name: 'Starter', level: 3 })).closest('article') as HTMLElement;
  await user.click(within(starter).getByRole('button', { name: 'Adicionar mais SDR' }));
  expect(within(starter).getByText('R$ 1.098,00')).toBeInTheDocument();
  for (let i = 0; i < 8; i += 1) await user.click(within(starter).getByRole('button', { name: 'Adicionar mais SDR' }));
  expect(within(starter).getByText('14 SDRs')).toBeInTheDocument();
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
  await user.click(within(starter).getByRole('button', { name: 'Adicionar mais SDR' }));
  await user.click(within(starter).getByRole('button', { name: /Assinar este plano/ }));
  await waitFor(() => expect(body).toMatchObject({ planCode: 'starter', interval: 'month', totalSdrSeats: 6 }));
});

it('usa o mesmo controle de seats para uma assinatura ativa', async () => {
  installCatalog({
    mode: 'full', reason: 'active_subscription', planCode: 'starter', planName: 'Starter', includedSdrs: 5,
    maxSdrs: 6, planMaxSdrs: 14, purchasedExtraSdrs: 1, usedSdrSeats: 4, reservedSdrSeats: 0,
    subscription: { status: 'active', billing_interval: 'month' },
  });
  const previewBody: Record<string, unknown> = {};
  server.use(
    http.post('http://localhost:3000/api/tenants/tenant-a/billing/seats/preview', async ({ request }) => { Object.assign(previewBody, await request.json()); return HttpResponse.json({ targetTotalSeats: 7, effectiveAt: 'immediate' }); }),
    http.post('http://localhost:3000/api/tenants/tenant-a/billing/seats', () => HttpResponse.json({ changeId: 'change-1' })),
  );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<BillingPage tenantId="tenant-a" />);
  const capacity = (await screen.findByRole('heading', { name: 'Gerencie seus SDRs' })).closest('section') as HTMLElement;
  expect(within(capacity).getByText('6 SDRs')).toBeInTheDocument();
  await user.click(within(capacity).getByRole('button', { name: 'Adicionar mais SDR' }));
  expect(within(capacity).getByText('7 SDRs')).toBeInTheDocument();
  await user.click(within(capacity).getByRole('button', { name: 'Salvar alteração' }));
  await waitFor(() => expect(previewBody).toMatchObject({ totalSdrSeats: 7 }));
  expect(confirm).toHaveBeenCalled();
  confirm.mockRestore();
});

it('mantém o cálculo monetário inteiro para evitar erros de ponto flutuante', () => {
  expect(calculatePlanTotal(8990, 5, 7, 1990)).toBe(12970);
  expect(calculatePlanTotal(89900, 5, 7, 19900)).toBe(129700);
});
