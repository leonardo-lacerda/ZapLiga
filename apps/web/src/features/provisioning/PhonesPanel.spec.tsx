import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { PhonesPanel } from './PhonesPanel';
import { API, phone } from './provisioning.fixtures';

afterEach(() => vi.restoreAllMocks());

it('mostra quem está ligado, o custo por hora e desliga com confirmação', async () => {
  const stopped: string[] = [];
  let phones = [
    phone({ id: 'p1', name: 'WhatsApp 1', status: 'on' }),
    phone({ id: 'p2', name: 'WhatsApp 2', status: 'starting' }),
    phone({ id: 'p3', name: 'WhatsApp 3', status: 'off' }),
  ];
  server.use(
    http.get(`${API}/phones`, () => HttpResponse.json({ items: phones })),
    http.post(`${API}/phones/:id/stop`, ({ params }) => {
      stopped.push(String(params.id));
      phones = phones.map((item) => (item.id === params.id ? { ...item, status: 'off' as const } : item));
      return HttpResponse.json(phones.find((item) => item.id === params.id));
    }),
  );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<PhonesPanel tenantId="tenant-1" refreshMs={60_000} />);

  expect(await screen.findByText('2 telefones ligados')).toBeInTheDocument();
  // 2 phones × 60 min × US$ 0,007
  expect(screen.getByText(/US\$ 0,84 por hora/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Desligar WhatsApp 3' })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Desligar WhatsApp 1' }));
  expect(confirm).toHaveBeenCalledWith('Desligar WhatsApp 1?');
  expect(await screen.findByText('1 telefone ligado')).toBeInTheDocument();
  expect(stopped).toEqual(['p1']);

  const row = screen.getByText('WhatsApp 1').closest('li')!;
  expect(within(row).getByText('Desligado')).toBeInTheDocument();
});

it('avisa que desligar cancela o cadastro em andamento e desliga todos de uma vez', async () => {
  let phones = [
    phone({ id: 'p1', name: 'WhatsApp 1', status: 'on', busyJobId: 'job-1' }),
    phone({ id: 'p2', name: 'WhatsApp 2', status: 'on' }),
  ];
  server.use(
    http.get(`${API}/phones`, () => HttpResponse.json({ items: phones })),
    http.post(`${API}/phones/:id/stop`, ({ params }) => {
      phones = phones.map((item) => (item.id === params.id ? { ...item, status: 'off' as const, busyJobId: null } : item));
      return HttpResponse.json(phones.find((item) => item.id === params.id));
    }),
  );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<PhonesPanel tenantId="tenant-1" refreshMs={60_000} />);

  expect(await screen.findByText(/em cadastro agora/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Desligar todos' }));
  expect(confirm.mock.calls[0][0]).toMatch(/WhatsApp 1 está no meio de um cadastro, que será cancelado/);
  expect(await screen.findByText('Nenhum telefone ligado: nada sendo cobrado agora.')).toBeInTheDocument();
});

it('não desliga quando o usuário desiste', async () => {
  const stop = vi.fn();
  server.use(
    http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone({ id: 'p1', name: 'WhatsApp 1', status: 'on' })] })),
    http.post(`${API}/phones/:id/stop`, () => { stop(); return HttpResponse.json({}); }),
  );
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<PhonesPanel tenantId="tenant-1" refreshMs={60_000} />);

  await userEvent.click(await screen.findByRole('button', { name: 'Desligar WhatsApp 1' }));
  expect(stop).not.toHaveBeenCalled();
  expect(screen.getByText('1 telefone ligado')).toBeInTheDocument();
});
