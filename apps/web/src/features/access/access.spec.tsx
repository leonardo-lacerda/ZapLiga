import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { AccessPage } from './AccessPage';

it('shows invitation delivery and lets a leader promote another member', async () => {
  const rolePatch = vi.fn();
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/members', () => HttpResponse.json({ items: [{ user_id: 'user-1', name: 'Atual', email: 'current@example.com', role: 'leader', status: 'active', user_status: 'active' }, { user_id: 'user-2', name: 'Colega', email: 'peer@example.com', role: 'sdr', status: 'active', user_status: 'active' }], total: 2 })),
    http.get('http://localhost:3000/api/tenants/tenant-1/invitations', () => HttpResponse.json({ items: [{ id: 'invite-1', invited_email: 'new@example.com', role: 'sdr', expires_at: new Date(Date.now() + 60_000).toISOString(), display_status: 'opened' }], total: 1 })),
    http.get('http://localhost:3000/api/auth/me', () => HttpResponse.json({ user: { id: 'user-1', email: 'current@example.com' } })),
    http.patch('http://localhost:3000/api/tenants/tenant-1/members/user-2/role', async ({ request }) => { rolePatch(await request.json()); return HttpResponse.json({ role: 'leader' }); }),
  );
  render(<AccessPage tenantId="tenant-1" role="leader" />);
  expect(await screen.findByText('Aberto')).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Papel de Colega' }), 'leader');
  await waitFor(() => expect(rolePatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'leader' })));
});
