import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { CompliancePage } from './CompliancePage';

it('creates and then renders a canonical suppression', async () => {
  let items: any[] = [];
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/contact-suppressions', () => HttpResponse.json({ items, total: items.length })),
    http.post('http://localhost:3000/api/tenants/tenant-1/contact-suppressions', async ({ request }) => { const body = await request.json() as any; items = [{ id: 's1', phone: body.phone, reason: body.reason, source: body.source, created_at: new Date().toISOString() }]; return HttpResponse.json(items[0]); }),
  );
  render(<CompliancePage tenantId="tenant-1" />);
  await screen.findByText('Nenhum telefone bloqueado');
  await userEvent.type(screen.getByPlaceholderText('Telefone com DDD'), '5511999999999');
  await userEvent.click(screen.getByRole('button', { name: 'Bloquear chamadas' }));
  expect(await screen.findByText('5511999999999')).toBeInTheDocument();
});
