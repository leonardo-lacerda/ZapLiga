import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, vi } from 'vitest';
import { server } from '../../test/setup';
import { OrganizerOverview } from './OrganizerOverview';

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => vi.unstubAllGlobals());

it('organiza a visão geral em decisão, atenção, operação e desempenho', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  server.use(
    http.post('http://localhost:3000/api/auth/operations-ws-ticket', () => HttpResponse.json({ ticket: 'ticket-1' })),
    http.get('http://localhost:3000/api/onboarding', () => HttpResponse.json({ completed: 6, total: 6, steps: [] })),
    http.get('http://localhost:3000/api/dialer/operations', () => HttpResponse.json({
      generated_at: new Date().toISOString(),
      simultaneous_limit: 10,
      attempts_today: 7,
      leads_attended_today: 2,
      active_calls: 1,
      available_sdrs: 1,
      settings: { global_max_concurrent_calls: 10 },
      sdrs: [{ id: 'sdr-1', name: 'Joana Lima', state: 'available', available: true }],
      queue: { total: 2, preview: [] },
      numbers: [{ id: 'number-1', label: 'Linha principal', status: 'connected', active_calls: 1, max_concurrent_calls: 2 }],
    })),
  );

  render(<OrganizerOverview
    tenantId="tenant-1"
    connectedNumbers={0}
    toggleDialer={vi.fn()}
    dateRange={{ from: '2026-09-01', to: '2026-09-01' }}
    logs={[]}
    status={{
      running: false,
      answered: 3,
      answer_rate: 42,
      call_counts: { completed: 8 },
      lead_counts: { queued: 5 },
      queue: { total: 5 },
      sdrs: [],
      settings: {},
      schedule: { allowed: true, timezone: 'America/Sao_Paulo' },
    }}
  />);

  expect(screen.getByRole('heading', { name: 'Visão geral' })).toBeInTheDocument();
  expect(screen.getByText('Resolva os próximos bloqueios')).toBeInTheDocument();
  expect(screen.getByText('Nenhuma linha disponível')).toBeInTheDocument();
  expect(screen.getByText('Convide o primeiro SDR')).toBeInTheDocument();
  expect(await screen.findByText('Operação agora')).toBeInTheDocument();
  expect(screen.getByText('Resultado da operação')).toBeInTheDocument();
  expect(screen.getByText('Últimos eventos')).toBeInTheDocument();
});
