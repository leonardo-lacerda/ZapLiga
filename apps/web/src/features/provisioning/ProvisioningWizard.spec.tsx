import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { API, egressNode, job, phone } from './provisioning.fixtures';
import { ProvisioningWizard } from './ProvisioningWizard';

const otherNode = egressNode({ node: 'b7c1e2f3-0000-4000-8000-000000000002', label: 'PC do Bruno', pcName: 'PC do Bruno', isMine: false, userId: null, userName: null });
const offlineNode = egressNode({ node: 'c3d4e5f6-0000-4000-8000-000000000003', label: 'Carla', pcName: 'PC da Carla', isMine: false, online: false, userId: 'user-3', userName: 'Carla' });

describe('ProvisioningWizard — passo 0 (Rede)', () => {
  it('pré-seleciona o PC do usuário online e deixa os offline visíveis, mas desabilitados', async () => {
    server.use(http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [otherNode, egressNode(), offlineNode] })));
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={vi.fn()} />);

    const mine = await screen.findByRole('radio', { name: /^Ana/ });
    expect(mine).toHaveAttribute('aria-checked', 'true');
    expect(within(mine).getByText('você')).toBeInTheDocument();
    // Rótulo = pessoa; o nome do PC vai na segunda linha. Sem IPs informados, nenhuma linha de IP.
    expect(within(mine).getByText('PC da Ana')).toBeInTheDocument();
    expect(within(mine).queryByText(/IP/)).not.toBeInTheDocument();
    const other = screen.getByRole('radio', { name: /PC do Bruno/ });
    expect(other).toHaveAttribute('aria-checked', 'false');
    // Rótulo igual ao nome do PC e sem IPs: não há segunda linha vazia.
    expect(other.querySelector('small')).toBeNull();
    const offline = screen.getByRole('radio', { name: /^Carla/ });
    expect(offline).toBeDisabled();
    expect(within(offline).getByText('offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled();
  });

  it('mostra os IPs quando a API os informa', async () => {
    server.use(http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode({ publicIps: ['189.10.20.30'] })] })));
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={vi.fn()} />);

    const mine = await screen.findByRole('radio', { name: /^Ana/ });
    expect(within(mine).getByText('PC da Ana · 189.10.20.30')).toBeInTheDocument();
  });

  it('avisa quando o PC do usuário está offline e só continua depois de escolher outro PC online', async () => {
    server.use(http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode({ online: false }), otherNode] })));
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={vi.fn()} />);

    expect(await screen.findByText(/Seu PC não está online/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Ana/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: /PC do Bruno/ }));
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled();
  });

  it('bloqueia o cadastro quando nenhum PC está online', async () => {
    server.use(http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [offlineNode] })));
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={vi.fn()} />);
    expect(await screen.findByText(/Nenhum PC está online agora/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });

  it('"Este PC é meu" liga o PC selecionado ao usuário logado', async () => {
    let body: Record<string, unknown> | null = null;
    let path = '';
    server.use(
      http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [otherNode] })),
      http.put(`${API}/egress/:node`, async ({ request, params }) => {
        body = await request.json() as Record<string, unknown>; path = String(params.node);
        return HttpResponse.json({ ...otherNode, label: 'Ana', userId: 'user-1', userName: 'Ana', isMine: true });
      }),
    );
    render(<ProvisioningWizard tenantId="tenant-1" currentUserId="user-1" onJobCreated={vi.fn()} />);

    expect(await screen.findByText('Nenhum PC está ligado a você. Escolha um PC online da operação.')).toBeInTheDocument();
    // Nada selecionado ainda: sem botão.
    expect(screen.queryByRole('button', { name: 'Este PC é meu' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /PC do Bruno/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Este PC é meu' }));

    const mine = await screen.findByRole('radio', { name: /^Ana/ });
    expect(path).toBe(otherNode.node);
    expect(body).toEqual({ userId: 'user-1' });
    expect(mine).toHaveAttribute('aria-checked', 'true');
    expect(within(mine).getByText('você')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Este PC é meu' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeEnabled();
  });

  it('avisa de quem é o PC e mostra o erro se a ligação falhar', async () => {
    const carlaOnline = { ...offlineNode, online: true };
    server.use(
      http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [carlaOnline] })),
      http.put(`${API}/egress/:node`, () => HttpResponse.json({ message: 'Essa pessoa não faz parte desta empresa' }, { status: 400 })),
    );
    render(<ProvisioningWizard tenantId="tenant-1" currentUserId="user-1" onJobCreated={vi.fn()} />);

    await userEvent.click(await screen.findByRole('radio', { name: /^Carla/ }));
    expect(screen.getByText(/Este PC está ligado a/)).toHaveTextContent('Este PC está ligado a Carla.');
    await userEvent.click(screen.getByRole('button', { name: 'Este PC é meu' }));
    expect(await screen.findByText('Essa pessoa não faz parte desta empresa')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Carla/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('sem o usuário logado não oferece "Este PC é meu"', async () => {
    server.use(http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [otherNode] })));
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={vi.fn()} />);
    await userEvent.click(await screen.findByRole('radio', { name: /PC do Bruno/ }));
    expect(screen.queryByRole('button', { name: 'Este PC é meu' })).not.toBeInTheDocument();
  });

  it('mostra uma mensagem clara quando a saída pelos PCs não está configurada no servidor', async () => {
    server.use(http.get(`${API}/egress`, () => HttpResponse.json({ configured: false, items: [] })));
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={vi.fn()} />);
    expect(await screen.findByText('A saída pelos PCs dos atendentes ou o proxy do cadastro não estão configurados no servidor.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });
});

describe('ProvisioningWizard — passos 1 a 3', () => {
  it('desabilita phone ocupado, mostra apps instalados, valida o número e cria o job', async () => {
    let created: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode()] })),
      http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone(), phone({ id: 'phone-3', name: 'Phone 3', status: 'on', busyJobId: 'job-9' })] })),
      http.post(`${API}/jobs`, async ({ request }) => { created = await request.json() as Record<string, unknown>; return HttpResponse.json(job(), { status: 201 }); }),
    );
    const onJobCreated = vi.fn();
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={onJobCreated} />);

    await screen.findByRole('radio', { name: /^Ana/ });
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    const busy = await screen.findByRole('radio', { name: /Phone 3/ });
    expect(busy).toBeDisabled();
    expect(within(busy).getByText(/Em uso por outro cadastro/)).toBeInTheDocument();
    const free = screen.getByRole('radio', { name: /Phone 2/ });
    expect(within(free).getByText('Android 12')).toBeInTheDocument();
    expect(within(free).getByText(/socks5 209\.50\.229\.249:1080/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
    await userEvent.click(free);
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    const whatsapp = screen.getByRole('radio', { name: /^WhatsApp Já instalado/ });
    expect(within(whatsapp).getByText('instalado')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /WhatsApp Business/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(screen.getByLabelText('Código do país')).toHaveValue('55');
    // Sem opção de manter ligado: o phone sempre desliga no fim (cobrança por minuto).
    expect(screen.queryByRole('checkbox', { name: /Desligar o phone/ })).not.toBeInTheDocument();
    expect(screen.getByText(/desligado sozinho ao terminar/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Número'), '1198');
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar cadastro' }));
    expect(await screen.findByText(/DDD \+ número/)).toBeInTheDocument();
    expect(created).toBeNull();

    await userEvent.clear(screen.getByLabelText('Número'));
    await userEvent.type(screen.getByLabelText('Número'), '(11) 98765-4321');
    expect(screen.getByText('+55 11 98765-4321')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar cadastro' }));

    await vi.waitFor(() => expect(onJobCreated).toHaveBeenCalled());
    expect(created).toEqual({ egressNode: 'a55241de-0000-4000-8000-000000000001', geelarkPhoneId: 'phone-2', app: 'business', countryCode: '55', number: '11987654321' });
  });

  it('volta para a rede quando a API recusa porque o PC ficou offline', async () => {
    let egressCalls = 0;
    server.use(
      http.get(`${API}/egress`, () => { egressCalls += 1; return HttpResponse.json({ configured: true, items: [egressNode({ online: egressCalls === 1 })] }); }),
      http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone()] })),
      http.post(`${API}/jobs`, () => HttpResponse.json({ code: 'egress_offline', message: 'egress_offline' }, { status: 409 })),
    );
    render(<ProvisioningWizard tenantId="tenant-1" prefill={{ phoneId: 'phone-2', number: '11987654321' }} onJobCreated={vi.fn()} />);
    await screen.findByRole('radio', { name: /^Ana/ });
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByRole('radio', { name: /Phone 2/ });
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar cadastro' }));

    expect(await screen.findByText(/O PC escolhido ficou offline/)).toBeInTheDocument();
    expect(await screen.findByText(/Seu PC não está online/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });
});

describe('ProvisioningWizard — telefones criados pelo ZapLiga', () => {
  const goToPhones = async () => {
    await screen.findByRole('radio', { name: /^Ana/ });
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByRole('radio', { name: /Phone 2/ });
  };

  it('cria o telefone já saindo pelo PC escolhido e abre o teste de internet', async () => {
    let createdPhone: Record<string, unknown> | null = null;
    let createdJob: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode()] })),
      http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone()] })),
      http.post(`${API}/phones`, async ({ request }) => { createdPhone = await request.json() as Record<string, unknown>; return HttpResponse.json(phone({ id: 'phone-9', name: 'Vendas 1', apps: { whatsapp: null, business: null } }), { status: 201 }); }),
      http.post(`${API}/jobs`, async ({ request }) => { createdJob = await request.json() as Record<string, unknown>; return HttpResponse.json(job({ mode: 'network_check', app: null, number: null, geelarkPhoneId: 'phone-9' }), { status: 201 }); }),
    );
    const onJobCreated = vi.fn();
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={onJobCreated} />);
    await goToPhones();

    await userEvent.click(screen.getByRole('button', { name: 'Novo telefone' }));
    const form = screen.getByRole('group', { name: 'Novo telefone' });
    expect(within(form).getByText('PC da Ana')).toBeInTheDocument();
    const name = within(form).getByLabelText('Nome');
    expect(name).toHaveValue('WhatsApp 2');
    await userEvent.clear(name);
    await userEvent.type(name, 'Vendas 1');
    await userEvent.selectOptions(within(form).getByLabelText('Sistema'), 'Android 13');
    expect(within(form).getByRole('switch')).toBeChecked();
    await userEvent.click(within(form).getByRole('button', { name: 'Criar telefone' }));

    await vi.waitFor(() => expect(onJobCreated).toHaveBeenCalledWith(expect.objectContaining({ mode: 'network_check' })));
    expect(createdPhone).toEqual({ name: 'Vendas 1', androidVersion: 'Android 13', egressNode: egressNode().node });
    expect(createdJob).toEqual({ egressNode: egressNode().node, geelarkPhoneId: 'phone-9', mode: 'network_check' });
  });

  it('sem o teste, o telefone novo entra na lista já selecionado; o Enter no nome cria em vez de avançar', async () => {
    server.use(
      http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode()] })),
      http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone()] })),
      http.post(`${API}/phones`, () => HttpResponse.json(phone({ id: 'phone-9', name: 'WhatsApp 2', apps: { whatsapp: null, business: null } }), { status: 201 })),
    );
    const onJobCreated = vi.fn();
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={onJobCreated} />);
    await goToPhones();

    await userEvent.click(screen.getByRole('button', { name: 'Novo telefone' }));
    const form = screen.getByRole('group', { name: 'Novo telefone' });
    await userEvent.click(within(form).getByRole('switch'));
    await userEvent.type(within(form).getByLabelText('Nome'), '{Enter}');

    const created = await screen.findByRole('radio', { name: /^WhatsApp 2/ });
    expect(created).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('group', { name: 'Novo telefone' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Telefone' })).toBeInTheDocument();
    expect(onJobCreated).not.toHaveBeenCalled();
  });

  it('mostra o motivo quando o GeeLark não consegue usar a internet do PC', async () => {
    const reason = 'O GeeLark testou a internet pelo PC escolhido e ela não respondeu. Confira se o PC está online e tente de novo.';
    server.use(
      http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode()] })),
      http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone()] })),
      http.post(`${API}/phones`, () => HttpResponse.json({ statusCode: 409, code: 'egress_offline', message: reason }, { status: 409 })),
    );
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={vi.fn()} />);
    await goToPhones();

    await userEvent.click(screen.getByRole('button', { name: 'Novo telefone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Criar telefone' }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    // O formulário continua aberto para tentar de novo.
    expect(screen.getByRole('group', { name: 'Novo telefone' })).toBeInTheDocument();
  });

  it('testa a internet de um telefone que já existe', async () => {
    let createdJob: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API}/egress`, () => HttpResponse.json({ configured: true, items: [egressNode()] })),
      http.get(`${API}/phones`, () => HttpResponse.json({ items: [phone()] })),
      http.post(`${API}/jobs`, async ({ request }) => { createdJob = await request.json() as Record<string, unknown>; return HttpResponse.json(job({ mode: 'network_check', app: null, number: null }), { status: 201 }); }),
    );
    const onJobCreated = vi.fn();
    render(<ProvisioningWizard tenantId="tenant-1" onJobCreated={onJobCreated} />);
    await goToPhones();

    expect(screen.queryByRole('button', { name: /Testar internet/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Phone 2/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Testar internet de Phone 2' }));

    await vi.waitFor(() => expect(onJobCreated).toHaveBeenCalled());
    expect(createdJob).toEqual({ egressNode: egressNode().node, geelarkPhoneId: 'phone-2', mode: 'network_check' });
  });
});
