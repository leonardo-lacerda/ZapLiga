import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { LeadIntegrationsPage } from './LeadIntegrationsPage';

describe('LeadIntegrationsPage', () => {
  it('creates an integration and shows one-time credentials', async () => {
    server.use(
      http.get('http://localhost:3000/api/tenants/tenant-1/lead-integrations', () => HttpResponse.json([])),
      http.get('http://localhost:3000/api/tenants/tenant-1/lead-ingestion/events', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('http://localhost:3000/api/tenants/tenant-1/lead-integrations', () => HttpResponse.json({ api_key: 'zpl_in_test', signing_secret: 'zpl_sig_test', webhook_url: '/api/v1/lead-integrations/li_test/webhook' })),
    );
    render(<LeadIntegrationsPage tenantId="tenant-1" folders={[{ id: 'folder-1', name: 'Lista principal', is_active: true }]} />);
    await screen.findByText('Nenhuma integração configurada');
    expect(screen.getByText(/http:\/\/localhost:3000\/api\/v1\/lead-integrations\/\{public_id\}\/leads/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Nome da integração'), { target: { value: 'CRM principal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar credenciais' }));
    expect(await screen.findByText('Credenciais prontas')).toBeInTheDocument();
    expect(screen.getByDisplayValue('zpl_in_test')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/\/api\/v1\/lead-integrations\/li_test\/webhook$/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Integração criada/)).toBeInTheDocument());
  });
});
