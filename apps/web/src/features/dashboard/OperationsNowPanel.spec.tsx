import { act, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, vi } from 'vitest';
import { server } from '../../test/setup';
import { OperationsNowPanel } from './OperationsNowPanel';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
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

const snapshot = {
  generated_at: new Date().toISOString(),
  simultaneous_limit: 20,
  attempts_today: 12,
  leads_attended_today: 4,
  active_calls: 1,
  available_sdrs: 0,
  settings: { global_max_concurrent_calls: 20 },
  sdrs: [{
    id: 'sdr-1', name: 'Joana Lima', state: 'in_call', available: false,
    active_call_id: 'call-1', active_call_status: 'media_active', active_call_connected_at: new Date(Date.now() - 35_000).toISOString(), active_call_elapsed_seconds: 35,
    active_lead_name: 'Carlos Silva', active_lead_phone: '5511999999999', active_number_label: 'Linha principal',
  }],
  queue: { total: 2, preview: [{ id: 'lead-2', name: 'Fernanda Souza', phone: '5511888888888', status: 'queued', next_eligible_at: new Date().toISOString() }] },
  numbers: [{ id: 'number-1', label: 'Linha principal', status: 'connected', active_calls: 1, max_concurrent_calls: 2, cooldown_remaining_seconds: 0 }],
};

afterEach(() => vi.unstubAllGlobals());

it('exibe o estado operacional e atualiza o toast ao receber um evento', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  server.use(
    http.post('http://localhost:3000/api/auth/operations-ws-ticket', () => HttpResponse.json({ ticket: 'ticket-1' })),
    http.get('http://localhost:3000/api/dialer/operations', () => HttpResponse.json(snapshot)),
  );

  render(<OperationsNowPanel tenantId="tenant-1" />);

  expect(await screen.findByText('Operação agora')).toBeInTheDocument();
  expect(screen.getByText('Joana Lima')).toBeInTheDocument();
  expect(screen.getByText(/Carlos Silva · \*/)).toBeInTheDocument();
  expect(screen.getByText('Tentativas hoje')).toBeInTheDocument();
  expect(screen.getByText('12')).toBeInTheDocument();
  expect(screen.getAllByText('Em chamada').length).toBeGreaterThan(0);

  act(() => { FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify({ type: 'operations_changed', activity: { kind: 'lead_rescheduled', leadName: 'Marcos Lima' } }) }); });
  expect(await screen.findByText('Nova tentativa agendada')).toBeInTheDocument();
  expect(screen.getByText('Marcos Lima · voltou para a fila')).toBeInTheDocument();
});
