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
    expect(screen.getByRole('checkbox', { name: /Desligar o phone ao terminar/ })).toBeChecked();
    await userEvent.type(screen.getByLabelText('Número'), '1198');
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar cadastro' }));
    expect(await screen.findByText(/DDD \+ número/)).toBeInTheDocument();
    expect(created).toBeNull();

    await userEvent.clear(screen.getByLabelText('Número'));
    await userEvent.type(screen.getByLabelText('Número'), '(11) 98765-4321');
    expect(screen.getByText('+55 11 98765-4321')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /Desligar o phone ao terminar/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Iniciar cadastro' }));

    await vi.waitFor(() => expect(onJobCreated).toHaveBeenCalled());
    expect(created).toEqual({ egressNode: 'a55241de-0000-4000-8000-000000000001', geelarkPhoneId: 'phone-2', app: 'business', countryCode: '55', number: '11987654321', powerOffWhenDone: false });
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
