import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { OperationSettingsPage } from './OperationSettingsPage';

it('loads and applies a schedule without restarting the API', async () => {
  let saved: any;
  server.use(
    http.get('http://localhost:3000/api/dialer/schedule', () => HttpResponse.json({ timezone: 'America/Sao_Paulo', windows: [{ day_of_week: 1, start_time: '09:00', end_time: '18:00' }], exceptions: [] })),
    http.patch('http://localhost:3000/api/dialer/settings', () => HttpResponse.json({ ok: true })),
    http.put('http://localhost:3000/api/dialer/schedule', async ({ request }) => { saved = await request.json(); return HttpResponse.json(saved); }),
  );
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<OperationSettingsPage status={{ settings: { global_max_concurrent_calls: 3, max_attempts_per_lead: 2, retry_delay_minutes: 10, ring_timeout_seconds: 30, default_number_cooldown_seconds: 5 }, schedule: { allowed: true } }} onChanged={changed} />);
  expect(await screen.findByDisplayValue('09:00')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Adicionar exceção' }));
  await userEvent.type(screen.getByLabelText('Data'), '2026-12-25');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar configurações' }));
  await waitFor(() => expect(saved.exceptions).toHaveLength(1));
  expect(changed).toHaveBeenCalled();
});

it('keeps unsaved windows and limits when the panel refreshes its status', async () => {
  let scheduleLoads = 0;
  server.use(
    http.get('http://localhost:3000/api/dialer/schedule', () => { scheduleLoads += 1; return HttpResponse.json({ timezone: 'America/Sao_Paulo', windows: [{ day_of_week: 1, start_time: '09:00', end_time: '18:00' }], exceptions: [] }); }),
  );
  const status = () => ({ settings: { global_max_concurrent_calls: 3, max_attempts_per_lead: 2, retry_delay_minutes: 10, ring_timeout_seconds: 30, default_number_cooldown_seconds: 5 }, schedule: { allowed: true } });
  const changed = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<OperationSettingsPage status={status()} onChanged={changed} />);
  expect(await screen.findByDisplayValue('09:00')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Adicionar janela' }));
  const concurrent = screen.getByLabelText('Chamadas simultâneas');
  await userEvent.clear(concurrent);
  await userEvent.type(concurrent, '7');

  // the panel polls the dialer status every few seconds and hands down a new object
  rerender(<OperationSettingsPage status={status()} onChanged={changed} />);
  // give a reload, if any, time to land
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(screen.getAllByLabelText('Dia da semana')).toHaveLength(2);
  expect(screen.getByLabelText('Chamadas simultâneas')).toHaveValue(7);
  expect(scheduleLoads).toBe(1);
});
