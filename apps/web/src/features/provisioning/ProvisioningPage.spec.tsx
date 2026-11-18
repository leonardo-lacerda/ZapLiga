import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, vi } from 'vitest';
import { server } from '../../test/setup';
import { JobProgress } from './JobProgress';
import { API, egressNode, historyOf, job, phone } from './provisioning.fixtures';
import { ProvisioningPage } from './ProvisioningPage';
import type { Job } from './provisioning.types';

// A tela ao vivo e o quadro de telefones fazem polling em toda a página: respostas neutras por padrão.
beforeEach(() => {
  server.use(
    http.get(`${API}/jobs/:id/screen`, () => new HttpResponse(null, { status: 404 })),
    http.get(`${API}/phones`, () => HttpResponse.json({ items: [] })),
  );
});

const POLL_MS = 15;

const originalUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
afterEach(() => { URL.createObjectURL = originalUrl.create; URL.revokeObjectURL = originalUrl.revoke; });

it('faz o cadastro completo: rede → phone → app → número → SMS → perfil → conexão → pronto', async () => {
  let current: Job = job();
  let getCalls = 0;
  let afterGet: ((calls: number) => void) | null = null;
  const bodies: Record<string, unknown> = {};
  const set = (overrides: Partial<Job>) => { current = job({ ...overrides }); return current; };

  server.use(
    http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode()] })),
    http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone()] })),
    http.get(`${API}/jobs`, () => HttpResponse.json({ items: [] })),
    http.post(`${API}/jobs`, async ({ request }) => {
      bodies.create = await request.json();
      // O worker liga o phone e, depois de duas consultas, para no SMS.
      afterGet = (calls) => { if (calls >= 2) { set({ status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms', message: 'Aguardando o código SMS', history: historyOf('queued', 'starting_phone', 'entering_number', 'waiting_sms') }); afterGet = null; } };
      return HttpResponse.json(set({}), { status: 201 });
    }),
    http.get(`${API}/jobs/job-1`, () => { getCalls += 1; const response = HttpResponse.json(current); afterGet?.(getCalls); return response; }),
    http.post(`${API}/jobs/job-1/sms`, async ({ request }) => {
      bodies.sms = await request.json();
      const verifying = job({ status: 'running', step: 'verifying', awaiting: null, history: historyOf('queued', 'starting_phone', 'entering_number', 'waiting_sms', 'verifying') });
      // O WhatsApp aceita o código logo depois: a próxima consulta já mostra a tela de perfil.
      set({ status: 'waiting_input', step: 'waiting_profile', awaiting: 'profile', message: null, history: historyOf('queued', 'starting_phone', 'entering_number', 'waiting_sms', 'verifying', 'waiting_profile') });
      return HttpResponse.json(verifying);
    }),
    // O corpo multipart é conferido em provisioning.api.spec.ts (o FormData do jsdom não atravessa o fetch do Node).
    http.post(`${API}/jobs/job-1/profile`, () => {
      bodies.profile = true;
      return HttpResponse.json(set({ status: 'waiting_input', step: 'registered', awaiting: 'link_decision', history: historyOf('queued', 'starting_phone', 'waiting_sms', 'verifying', 'waiting_profile', 'saving_profile', 'registered') }));
    }),
    http.post(`${API}/jobs/job-1/link`, async ({ request }) => {
      bodies.link = await request.json();
      // Fica em "linking" até o teste confirmar o estado intermediário (abaixo): com a
      // suíte inteira rodando em paralelo, uma transição automática passava direto por ele.
      afterGet = null;
      return HttpResponse.json(set({ status: 'running', step: 'linking', awaiting: null, history: historyOf('registered', 'opening_link_screen', 'waiting_pair_code', 'entering_pair_code', 'linking') }));
    }),
  );

  const onOpenNumbers = vi.fn();
  render(<ProvisioningPage tenantId="tenant-1" allowed onOpenNumbers={onOpenNumbers} pollIntervalMs={POLL_MS} />);

  expect(await screen.findByText('Nenhum cadastro feito ainda.')).toBeInTheDocument();
  await screen.findByRole('radio', { name: /^Ana/ });
  await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  await userEvent.click(await screen.findByRole('radio', { name: /Phone 2/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  await userEvent.type(screen.getByLabelText('Número'), '11987654321');
  await userEvent.click(screen.getByRole('button', { name: 'Iniciar cadastro' }));

  // Progresso: linha do tempo em português e, na vez do usuário, o campo do SMS.
  expect(await screen.findByRole('heading', { name: '+55 11 98765-4321' })).toBeInTheDocument();
  const sms = await screen.findByLabelText('Código SMS');
  const timeline = screen.getByRole('list', { name: 'Linha do tempo do cadastro' });
  expect(within(timeline).getByText('Ligando o phone')).toBeInTheDocument();
  expect(within(timeline).getByText('Aguardando o código SMS')).toBeInTheDocument();
  await userEvent.click(sms);
  await userEvent.paste('123 456');
  expect(sms).toHaveValue('123-456');
  await userEvent.click(screen.getByRole('button', { name: 'Enviar código' }));
  expect(bodies.sms).toEqual({ code: '123456' });

  // Perfil: nome obrigatório; foto opcional.
  const name = await screen.findByLabelText('Nome do perfil');
  expect(screen.getByRole('button', { name: 'Salvar perfil' })).toBeDisabled();
  await userEvent.type(name, 'Comercial ZapLiga');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar perfil' }));

  // Conexão por telefone + código (padrão: ligada).
  const toggle = await screen.findByRole('switch', { name: /Conectar ao ZapLiga por telefone \+ código \(sem QR Code\)/ });
  expect(toggle).toBeChecked();
  expect(bodies.profile).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Conectar ao ZapLiga' }));
  expect(bodies.link).toEqual({ connect: true });
  expect(await screen.findByText('Conectando ao ZapLiga…')).toBeInTheDocument();
  // A sessão Waxum conectou: a próxima consulta já traz o job pronto.
  set({ status: 'done', step: 'done', awaiting: null, linked: true, numberId: 'number-9', history: historyOf('registered', 'opening_link_screen', 'waiting_pair_code', 'entering_pair_code', 'linking', 'done') });

  expect(await screen.findByText('Número cadastrado e conectado ao ZapLiga')).toBeInTheDocument();
  expect(bodies.create).toEqual({ egressNode: 'a55241de-0000-4000-8000-000000000001', geelarkPhoneId: 'phone-2', app: 'whatsapp', countryCode: '55', number: '11987654321' });

  // Terminado, a consulta para.
  const callsAtDone = getCalls;
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
  expect(getCalls).toBe(callsAtDone);

  await userEvent.click(screen.getByRole('button', { name: 'Ver em Números' }));
  expect(onOpenNumbers).toHaveBeenCalled();
});

it('mostra a mensagem do worker quando o código SMS está errado e deixa digitar de novo', async () => {
  let current = job({ status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms', message: 'Aguardando o código SMS', history: historyOf('queued', 'entering_number', 'waiting_sms') });
  server.use(
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(current)),
    http.post(`${API}/jobs/job-1/sms`, () => {
      current = job({ status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms', message: 'Código incorreto. Confira o SMS e digite de novo.', history: historyOf('queued', 'entering_number', 'waiting_sms', 'verifying', 'waiting_sms') });
      return HttpResponse.json(current);
    }),
  );
  render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={vi.fn()} onOpenNumbers={vi.fn()} />);

  const sms = await screen.findByLabelText('Código SMS');
  await userEvent.type(sms, '111111');
  await userEvent.click(screen.getByRole('button', { name: 'Enviar código' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Código incorreto. Confira o SMS e digite de novo.');
  expect(screen.getByLabelText('Código SMS')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Enviar código' })).toBeDisabled();
});

it('explica a falha pelo errorCode, mostra o print da tela e oferece tentar de novo', async () => {
  const createObjectURL = vi.fn(() => 'blob:screenshot-1');
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL;
  server.use(
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(job({ status: 'failed', step: 'entering_number', errorCode: 'number_banned', message: 'O WhatsApp informou que o número não pode ser usado.', hasScreenshot: true }))),
    http.get(`${API}/jobs/job-1/screenshot`, () => new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })),
  );
  const onNewJob = vi.fn();
  const { unmount } = render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={onNewJob} onOpenNumbers={vi.fn()} />);

  expect(await screen.findByText('O WhatsApp recusou este número')).toBeInTheDocument();
  expect(screen.getByText(/O número parece estar banido/)).toBeInTheDocument();
  expect(screen.getByText(/O WhatsApp informou que o número não pode ser usado/)).toBeInTheDocument();
  expect(await screen.findByRole('img', { name: /Print da tela do phone/ })).toHaveAttribute('src', 'blob:screenshot-1');
  expect(screen.queryByRole('button', { name: /Cancelar cadastro/ })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
  expect(onNewJob).toHaveBeenCalledWith({ egressNode: 'a55241de-0000-4000-8000-000000000001', phoneId: 'phone-2', app: 'whatsapp', countryCode: '55', number: '11987654321' });

  unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:screenshot-1');
});

it('cancela um cadastro em andamento depois de confirmar', async () => {
  let cancelled = false;
  server.use(
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(cancelled ? job({ status: 'cancelled', step: 'cancelled', errorCode: 'cancelled' }) : job())),
    http.post(`${API}/jobs/job-1/cancel`, () => { cancelled = true; return HttpResponse.json(job({ status: 'cancelled', step: 'cancelled', errorCode: 'cancelled' })); }),
  );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={vi.fn()} onOpenNumbers={vi.fn()} />);

  await userEvent.click(await screen.findByRole('button', { name: 'Cancelar cadastro' }));
  expect(confirm).toHaveBeenCalled();
  expect(await screen.findByText('Cadastro cancelado')).toBeInTheDocument();
  expect(cancelled).toBe(true);
});

it('reabre um cadastro em andamento pela lista de cadastros recentes', async () => {
  server.use(
    http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode()] })),
    http.get(`${API}/jobs`, () => HttpResponse.json({ items: [job({ status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms' })] })),
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(job({ status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms' }))),
  );
  render(<ProvisioningPage tenantId="tenant-1" allowed onOpenNumbers={vi.fn()} pollIntervalMs={POLL_MS} />);
  await userEvent.click(await screen.findByRole('button', { name: /Acompanhar cadastro de \+55 11 98765-4321/ }));
  expect(await screen.findByLabelText('Código SMS')).toBeInTheDocument();
});

it('na espera do SMS mostra a tela do phone ao vivo e pede reenvio ou ligação', async () => {
  const methods: string[] = [];
  let screenCalls = 0;
  let current = job({ status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms', message: 'Digite o código recebido por SMS.', history: historyOf('queued', 'entering_number', 'waiting_sms') });
  server.use(
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(current)),
    http.get(`${API}/jobs/job-1/screen`, () => { screenCalls += 1; return new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }); }),
    http.post(`${API}/jobs/job-1/resend`, async ({ request }) => {
      const { method } = await request.json() as { method: string };
      methods.push(method);
      current = job({ ...current, message: method === 'voice' ? 'Pedimos uma ligação com o código. Aguarde e digite o código quando chegar.' : 'Pedimos um novo SMS. Aguarde e digite o código quando chegar.' });
      return HttpResponse.json(current);
    }),
  );
  render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={vi.fn()} onOpenNumbers={vi.fn()} />);

  expect(await screen.findByText(/Tela do phone ao vivo/)).toBeInTheDocument();
  await vi.waitFor(() => expect(screenCalls).toBeGreaterThan(0));
  await userEvent.click(screen.getByRole('button', { name: 'Receber por ligação' }));
  expect(await screen.findByText(/Pedimos uma ligação com o código/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Reenviar SMS' }));
  expect(await screen.findByText(/Pedimos um novo SMS/)).toBeInTheDocument();
  expect(methods).toEqual(['voice', 'sms']);
  // O campo do código continua disponível.
  expect(screen.getByLabelText('Código SMS')).toBeInTheDocument();
});

it('numa tela desconhecida deixa tocar no phone pela tela ao vivo e devolver ao robô', async () => {
  const actions: unknown[] = [];
  let resumed = false;
  let current = job({ status: 'waiting_input', step: 'waiting_manual', awaiting: 'manual', message: "Tela desconhecida enquanto esperava 'digitar código'.", history: historyOf('queued', 'entering_number', 'waiting_manual') });
  URL.createObjectURL = vi.fn(() => 'blob:live-1');
  URL.revokeObjectURL = vi.fn();
  server.use(
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(current)),
    http.get(`${API}/jobs/job-1/screen`, () => new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })),
    http.post(`${API}/jobs/job-1/manual`, async ({ request }) => { actions.push(await request.json()); return HttpResponse.json({ ok: true }); }),
    http.post(`${API}/jobs/job-1/resume`, () => {
      resumed = true;
      current = job({ status: 'running', step: 'entering_number', awaiting: null, message: 'Digitando o número.', history: historyOf('queued', 'entering_number', 'waiting_manual', 'entering_number') });
      return HttpResponse.json(current);
    }),
  );
  render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={vi.fn()} onOpenNumbers={vi.fn()} />);

  expect(await screen.findByRole('heading', { name: 'O robô parou numa tela que não conhece' })).toBeInTheDocument();
  expect(screen.getByText(/digitar código/)).toBeInTheDocument();
  const touch = await screen.findByRole('button', { name: /Tocar na tela do phone/ });
  const image = within(touch).getByRole('img');
  image.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 400, right: 300, bottom: 450, x: 100, y: 50, toJSON: () => ({}) });
  await userEvent.pointer({ keys: '[MouseLeft]', target: touch, coords: { clientX: 150, clientY: 350 } });
  await vi.waitFor(() => expect(actions).toEqual([{ type: 'tap', x: 0.25, y: 0.75 }]));
  await userEvent.click(screen.getByRole('button', { name: 'Voltar no phone' }));
  await userEvent.type(screen.getByLabelText('Texto para digitar no phone'), 'Loja');
  await userEvent.click(screen.getByRole('button', { name: 'Digitar' }));
  await vi.waitFor(() => expect(actions).toEqual([{ type: 'tap', x: 0.25, y: 0.75 }, { type: 'key', key: 'back' }, { type: 'text', text: 'Loja' }]));
  expect(screen.getByLabelText('Texto para digitar no phone')).toHaveValue('');

  await userEvent.click(screen.getByRole('button', { name: 'Devolver ao robô' }));
  expect(await screen.findByText('Digitando o número.')).toBeInTheDocument();
  expect(resumed).toBe(true);
  // Com o robô andando de novo, a tela volta a ser só para olhar.
  expect(screen.queryByRole('button', { name: /Tocar na tela do phone/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Voltar no phone' })).not.toBeInTheDocument();
});

it('assume o controle com o robô andando: pede ao worker e mostra que está pausando', async () => {
  let current = job({ status: 'running', step: 'entering_number', awaiting: null, message: 'Digitando o número.', history: historyOf('queued', 'entering_number') });
  let asked = 0;
  server.use(
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(current)),
    http.post(`${API}/jobs/job-1/takeover`, () => {
      asked += 1;
      current = job({ ...current, message: 'Pausando o robô: ele para assim que chegar na próxima tela do WhatsApp.' });
      return HttpResponse.json(current);
    }),
  );
  render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={vi.fn()} onOpenNumbers={vi.fn()} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Assumir o controle' }));
  expect(await screen.findByRole('button', { name: 'Pausando o robô…' })).toBeDisabled();
  expect(asked).toBe(1);
  // Quando o robô para, o cartão de ajuda manual substitui o botão.
  current = job({ status: 'waiting_input', step: 'waiting_manual', awaiting: 'manual', message: 'Você assumiu o controle do phone.', history: historyOf('queued', 'entering_number', 'waiting_manual') });
  expect(await screen.findByRole('heading', { name: 'Você está no controle do phone' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Assumir o controle|Pausando/ })).not.toBeInTheDocument();
});

it('mostra o erro quando o robô ainda está mexendo no phone', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:live-2');
  URL.revokeObjectURL = vi.fn();
  server.use(
    http.get(`${API}/jobs/job-1`, () => HttpResponse.json(job({ status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms', history: historyOf('queued', 'waiting_sms') }))),
    http.get(`${API}/jobs/job-1/screen`, () => new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })),
    http.post(`${API}/jobs/job-1/manual`, () => HttpResponse.json({ statusCode: 409, code: 'robot_busy', message: 'O robô está mexendo no phone agora. Dá para mexer quando ele parar e pedir algo.' }, { status: 409 })),
  );
  render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={vi.fn()} onOpenNumbers={vi.fn()} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Tela inicial' }));
  expect(await screen.findByText(/O robô está mexendo no phone agora/)).toBeInTheDocument();
});

it('teste de internet: mostra o telefone, o IP conferido e leva ao cadastro nesse telefone', async () => {
  server.use(http.get(`${API}/jobs/job-1`, () => HttpResponse.json(job({
    mode: 'network_check', app: null, number: null, status: 'done', step: 'network_ok', egressIp: '131.255.254.90',
    message: 'Internet ok: o phone sai pelo IP 131.255.254.90, o mesmo do PC escolhido.',
    history: historyOf('queued', 'setting_network', 'starting_phone', 'connecting_adb', 'checking_network', 'network_ok'),
  }))));
  const onNewJob = vi.fn();
  render(<JobProgress tenantId="tenant-1" jobId="job-1" pollIntervalMs={POLL_MS} onBack={vi.fn()} onNewJob={onNewJob} onOpenNumbers={vi.fn()} />);

  expect(await screen.findByText('Internet do telefone ok')).toBeInTheDocument();
  expect(screen.getByText('TESTE DE INTERNET')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Phone 2' })).toBeInTheDocument();
  expect(screen.getByText(/sai pelo IP 131\.255\.254\.90, o mesmo do PC escolhido\. Ele já foi desligado\./)).toBeInTheDocument();
  expect(screen.getByText('Internet conferida')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Cadastrar número neste telefone' }));
  expect(onNewJob).toHaveBeenCalledWith({ egressNode: 'a55241de-0000-4000-8000-000000000001', phoneId: 'phone-2' });
});

it('não mostra o assistente sem permissão', () => {
  render(<ProvisioningPage tenantId="tenant-1" allowed={false} onOpenNumbers={vi.fn()} />);
  expect(screen.getByText('Cadastro de WhatsApp não disponível')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continuar' })).not.toBeInTheDocument();
});
