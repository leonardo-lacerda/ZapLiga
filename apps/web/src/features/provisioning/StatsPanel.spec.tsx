import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { StatsPanel } from './StatsPanel';
import { API } from './provisioning.fixtures';

const stats = {
  days: 30, total: 4, done: 3, failed: 1, cancelled: 0,
  failuresByError: [{ key: 'wait_limit', count: 1 }],
  failuresByStep: [{ key: 'waiting_sms', count: 1 }],
  byEgressIp: [{ key: '45.172.112.163', total: 4, done: 3 }],
  byAppVersion: [{ key: 'business 2.26.1', total: 4, done: 3 }],
  stepDurations: [{ key: 'opening_app', count: 4, median_s: 35, max_s: 120 }],
};

it('mostra quanto dá certo, onde falha e o tempo por etapa, e troca o período', async () => {
  const asked: string[] = [];
  server.use(http.get(`${API}/stats`, ({ request }) => {
    asked.push(new URL(request.url).searchParams.get('days') ?? '');
    return HttpResponse.json(stats);
  }));
  render(<StatsPanel tenantId="tenant-1" />);
  expect(await screen.findByText('(75%)')).toBeInTheDocument();
  expect(screen.getByText('O WhatsApp pediu para esperar')).toBeInTheDocument();
  expect(screen.getByText('45.172.112.163')).toBeInTheDocument();
  expect(screen.getByText('business 2.26.1')).toBeInTheDocument();
  expect(screen.getByText('35 s')).toBeInTheDocument();
  expect(screen.getByText('2 min')).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Período' }), '7');
  await vi.waitFor(() => expect(asked).toEqual(['30', '7']));
});

it('sem cadastros no período, diz isso', async () => {
  server.use(http.get(`${API}/stats`, () => HttpResponse.json({ ...stats, total: 0, done: 0, failed: 0 })));
  render(<StatsPanel tenantId="tenant-1" />);
  expect(await screen.findByText('Nenhum cadastro terminado nos últimos 30 dias.')).toBeInTheDocument();
});
