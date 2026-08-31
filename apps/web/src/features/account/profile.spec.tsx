import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { ProfilePage } from './ProfilePage';

it('revokes the selected session and logs out when it is current', async () => {
  server.use(
    http.get('http://localhost:3000/api/me/sessions', () => HttpResponse.json([{ id: 'session-1', current: true, user_agent: 'Chrome Windows', ip_address: '127.0.0.1', created_at: new Date().toISOString() }])),
    http.delete('http://localhost:3000/api/me/sessions/session-1', () => HttpResponse.json({ ok: true, current: true })),
  );
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const logout = vi.fn().mockResolvedValue(undefined);
  render(<ProfilePage session={{ user: { id: 'u1', name: 'User', email: 'user@example.com', platformRole: 'user', status: 'active' }, tenants: [] }} reload={vi.fn()} logout={logout} />);
  await screen.findByText('Esta sessão');
  await userEvent.click(screen.getByRole('button', { name: 'Encerrar' }));
  expect(logout).toHaveBeenCalled();
});
