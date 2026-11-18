import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { PhonesPanel } from './PhonesPanel';
import { API, egressNode, job, phone } from './provisioning.fixtures';

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

  expect(await screen.findByText(/em uso agora/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Desligar todos' }));
  expect(confirm.mock.calls[0][0]).toMatch(/WhatsApp 1 está no meio de um cadastro ou sessão, que será encerrado/);
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


it('abre um telefone desligado pelo PC escolhido e leva para a sessão', async () => {
  let created: Record<string, unknown> | null = null;
  server.use(
    http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone({ id: 'p3', name: 'WhatsApp 3', status: 'off' })] })),
    http.get(`${API}/egress`, () => HttpResponse.json({ items: [egressNode({ node: 'pc-1', label: 'Pc do Leo', online: true, isMine: true })], configured: true })),
    http.post(`${API}/jobs`, async ({ request }) => {
      created = await request.json() as Record<string, unknown>;
      return HttpResponse.json(job({ id: 'job-9', mode: 'control', app: null, number: null }), { status: 201 });
    }),
  );
  const onOpenJob = vi.fn();
  render(<PhonesPanel tenantId="tenant-1" refreshMs={60_000} onOpenJob={onOpenJob} />);

  expect(await screen.findByRole('combobox', { name: 'Abrir pelo PC' })).toHaveValue('pc-1');
  await userEvent.click(screen.getByRole('button', { name: 'Abrir WhatsApp 3' }));
  await vi.waitFor(() => expect(onOpenJob).toHaveBeenCalledWith('job-9'));
  expect(created).toEqual({ egressNode: 'pc-1', geelarkPhoneId: 'p3', mode: 'control' });
});

it('sem PC online, não deixa abrir', async () => {
  server.use(
    http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone({ id: 'p3', name: 'WhatsApp 3', status: 'off' })] })),
    http.get(`${API}/egress`, () => HttpResponse.json({ items: [egressNode({ online: false })], configured: true })),
  );
  render(<PhonesPanel tenantId="tenant-1" refreshMs={60_000} />);
  expect(await screen.findByText(/Nenhum PC online/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Abrir WhatsApp 3' })).toBeDisabled();
});

it('renomeia, gera aparelho novo com confirmação e apaga só com o nome digitado', async () => {
  const calls: string[] = [];
  let phones = [phone({ id: 'p3', name: 'WhatsApp 3', status: 'off' })];
  server.use(
    http.get(`${API}/phones`, () => HttpResponse.json({ items: phones })),
    http.post(`${API}/phones/:id/rename`, async ({ request, params }) => {
      const { name } = await request.json() as { name: string };
      calls.push(`rename:${params.id}:${name}`);
      phones = phones.map((item) => ({ ...item, name }));
      return HttpResponse.json(phones[0]);
    }),
    http.post(`${API}/phones/:id/new-device`, ({ params }) => { calls.push(`new:${params.id}`); return HttpResponse.json(phones[0]); }),
    http.delete(`${API}/phones/:id`, ({ params }) => { calls.push(`delete:${params.id}`); phones = []; return HttpResponse.json({ ok: true }); }),
  );
  const prompt = vi.spyOn(window, 'prompt');
  const confirm = vi.spyOn(window, 'confirm');
  render(<PhonesPanel tenantId="tenant-1" refreshMs={60_000} />);

  prompt.mockReturnValueOnce('WhatsApp 4');
  await userEvent.click(await screen.findByRole('button', { name: 'Renomear WhatsApp 3' }));
  expect(await screen.findByText('WhatsApp 4')).toBeInTheDocument();

  confirm.mockReturnValueOnce(false);
  await userEvent.click(screen.getByRole('button', { name: 'Gerar aparelho novo para WhatsApp 4' }));
  expect(confirm.mock.calls[0][0]).toMatch(/troca a marca, o modelo e o número do SIM/);
  confirm.mockReturnValueOnce(true);
  await userEvent.click(screen.getByRole('button', { name: 'Gerar aparelho novo para WhatsApp 4' }));
  await vi.waitFor(() => expect(calls).toContain('new:p3'));

  prompt.mockReturnValueOnce('outro nome');
  await userEvent.click(screen.getByRole('button', { name: 'Apagar WhatsApp 4' }));
  expect(await screen.findByText(/o nome digitado não confere; nada foi apagado/)).toBeInTheDocument();
  expect(calls).not.toContain('delete:p3');

  prompt.mockReturnValueOnce('WhatsApp 4');
  await userEvent.click(screen.getByRole('button', { name: 'Apagar WhatsApp 4' }));
  expect(await screen.findByText(/Nenhum telefone no GeeLark ainda/)).toBeInTheDocument();
  expect(calls).toEqual(['rename:p3:WhatsApp 4', 'new:p3', 'delete:p3']);
});
