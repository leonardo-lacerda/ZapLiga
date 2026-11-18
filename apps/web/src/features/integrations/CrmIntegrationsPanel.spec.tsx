import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { CrmIntegrationsPanel } from './CrmIntegrationsPanel';

describe('CrmIntegrationsPanel', () => {
  it('generates a key, shows it once and lists the integration as waiting for Franco', async () => {
    let created = false;
    server.use(
      http.get('http://localhost:3000/api/tenants/tenant-1/crm-integrations', () => HttpResponse.json(created ? [{ id: 'int-1', name: 'Franco CRM', api_key_prefix: 'zpl_crm_abcdefgh', status: 'active', connected_at: null, last_used_at: null }] : [])),
      http.post('http://localhost:3000/api/tenants/tenant-1/crm-integrations', () => { created = true; return HttpResponse.json({ id: 'int-1', api_key: 'zpl_crm_secret' }); }),
    );

    render(<CrmIntegrationsPanel tenantId="tenant-1" />);
    expect(await screen.findByText('Nenhuma integração com CRM')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Gerar chave' }));
    expect(await screen.findByDisplayValue('zpl_crm_secret')).toBeInTheDocument();
    expect(screen.getByText(/não será exibida novamente/)).toBeInTheDocument();
    expect(await screen.findByText('Aguardando o Franco')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Já copiei' }));
    expect(screen.queryByDisplayValue('zpl_crm_secret')).not.toBeInTheDocument();
  });

  it('generates a key that can only check WhatsApp', async () => {
    const bodies: unknown[] = [];
    let created = false;
    server.use(
      http.get('http://localhost:3000/api/tenants/tenant-1/crm-integrations', () => HttpResponse.json(created ? [{ id: 'int-2', name: 'Formulário', api_key_prefix: 'zpl_crm_check123', status: 'active', scopes: ['whatsapp:check'], connected_at: null, last_used_at: null }] : [])),
      http.post('http://localhost:3000/api/tenants/tenant-1/crm-integrations', async ({ request }) => { bodies.push(await request.json()); created = true; return HttpResponse.json({ id: 'int-2', api_key: 'zpl_crm_check' }); }),
    );

    render(<CrmIntegrationsPanel tenantId="tenant-1" />);
    await screen.findByText('Nenhuma integração com CRM');
    fireEvent.change(screen.getByLabelText('Nome da integração CRM'), { target: { value: 'Formulário' } });
    fireEvent.change(screen.getByLabelText('Permissões da chave'), { target: { value: 'whatsapp_check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar chave' }));

    expect(await screen.findByDisplayValue('zpl_crm_check')).toBeInTheDocument();
    expect(screen.getByText(/só verifica se um telefone tem WhatsApp/)).toBeInTheDocument();
    expect(await screen.findByText('Só verificação de WhatsApp')).toBeInTheDocument();
    expect(bodies).toEqual([{ name: 'Formulário', access: 'whatsapp_check' }]);
  });

  it('lists recent deliveries and requeues a failed one', async () => {
    let retried = false;
    server.use(
      http.get('http://localhost:3000/api/tenants/tenant-1/crm-integrations', () => HttpResponse.json([{ id: 'int-1', name: 'Franco CRM', api_key_prefix: 'zpl_crm_abcdefgh', status: 'active', connected_at: '2026-10-15T01:00:00Z', webhook_url: 'https://franco.example.com/webhooks/zapcall/x', last_used_at: null, last_delivery_at: null }])),
      http.get('http://localhost:3000/api/tenants/tenant-1/crm-integrations/int-1/events', () => HttpResponse.json({ items: [{ id: 'evt-1', event_type: 'call.ended', status: retried ? 'pending' : 'dead_letter', attempts: 10, last_error: 'HTTP 500', created_at: '2026-10-15T01:00:00Z' }] })),
      http.post('http://localhost:3000/api/tenants/tenant-1/crm-integrations/int-1/events/evt-1/retry', () => { retried = true; return HttpResponse.json({ id: 'evt-1', status: 'pending' }); }),
    );

    render(<CrmIntegrationsPanel tenantId="tenant-1" />);
    expect(await screen.findByText('Conectada')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ver entregas' }));
    expect(await screen.findByText('call.ended')).toBeInTheDocument();
    expect(screen.getByText('Falhou')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar' }));
    expect(await screen.findByText('Pendente')).toBeInTheDocument();
  });
});
