import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { LineMonitorPage } from './LineMonitorPage';

vi.mock('../dashboard/useOperationsRealtime', () => ({ useOperationsRealtime: () => ({ snapshot: null, connection: 'offline', error: '', activity: null, refresh: vi.fn() }) }));

const base = 'http://localhost:3000/api/tenants/tenant-1/line-monitor';
const now = {
  at: new Date().toISOString(),
  lines: [
    { id: 'n1', label: 'Previtas 13', status: 'connected', waxum_node: 'edge-1', canary_status: 'passed', young: true, calls_today: 46, reconnects_24h: 2, losses_recent: null },
    { id: 'n2', label: 'Previtas 14', status: 'disconnected', loss_reason: 'device_removed', waxum_node: 'edge-4', canary_status: 'passed', young: false, calls_today: 29, reconnects_24h: 1, losses_recent: { device_removed: 1 } },
  ],
  exits: [
    { id: 'pc1', name: 'Pc do Leo', slot: 'edge-1', kind: 'pc', online: true, lines: 13, online_since: new Date().toISOString() },
    { id: 'pc4', name: 'Tegrus-Do', slot: 'edge-4', kind: 'pc', online: false, lines: 4, offline_since: new Date().toISOString() },
  ],
  alerts: [
    { kind: 'pc_offline', label: 'Tegrus-Do', message: 'Tegrus-Do está sem internet com 4 linha(s) desta empresa.' },
    { kind: 'near_fall_point', numberId: 'n1', label: 'Previtas 13', message: 'Previtas 13 já fez 46 ligações desde o pareamento.' },
  ],
};

it('mostra PCs, linhas e alertas agora', async () => {
  server.use(http.get(`${base}/now`, () => HttpResponse.json(now)));
  render(<LineMonitorPage tenantId="tenant-1" />);

  expect(await screen.findByRole('heading', { name: 'Monitor de linhas' })).toBeInTheDocument();
  expect(await screen.findByText('Tegrus-Do está sem internet com 4 linha(s) desta empresa.')).toBeInTheDocument();
  expect(screen.getByText('Sem internet')).toBeInTheDocument();
  expect(screen.getByText('46/60')).toBeInTheDocument();
  expect(screen.getByText('Perto do ponto de queda')).toBeInTheDocument();
  expect(screen.getAllByText('Removida').length).toBeGreaterThan(0);
});

it('mostra os números do período, por atendente e por hora', async () => {
  server.use(
    http.get(`${base}/now`, () => HttpResponse.json(now)),
    http.get(`${base}/period`, () => HttpResponse.json({
      totals: { calls: 311, answered: 63, closed_1005: 97, active_lines: 10, lost_lines: 4 },
      lines: [{ number_id: 'n1', label: 'Previtas 13', waxum_node: 'edge-1', calls: 46, answered: 12, talk_seconds: 2592, closed_1005: 8, waxum_failures: 0, reconnects: 2, node_moves: 1, lost: false, losses: {} }],
      sdrs: [{ sdr_id: 's1', name: 'Rafael Ribeiro', calls: 99, answered: 12, talk_seconds: 2352, closed_1005: 40 }],
      hours: [{ hour: 15, calls: 59, answered: 8, talk_seconds: 1376, closed_1005: 23 }],
    })),
  );
  render(<LineMonitorPage tenantId="tenant-1" />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Período' }));

  expect(await screen.findByText('311')).toBeInTheDocument();
  expect(screen.getByText('Rafael Ribeiro')).toBeInTheDocument();
  expect(screen.getByText('15h')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Quedas com a ficha' })).toBeInTheDocument();
});

it('mostra a linha do tempo com a ficha da queda e salva uma nota', async () => {
  let posted: any = null;
  server.use(
    http.get(`${base}/now`, () => HttpResponse.json(now)),
    http.get(`${base}/timeline`, () => HttpResponse.json({ items: [
      { kind: 'loss', id: 'e1', number_id: 'n2', label: 'Previtas 14', code: 'device_removed', at: new Date().toISOString(), detail: { context: { callsSincePairing: 29, callsToday: 29, waxumNode: 'edge-4' } } },
      { kind: 'pc', id: 'p1', number_id: null, label: 'Tegrus-Do', code: 'offline', at: new Date().toISOString(), detail: { slot: 'edge-4' } },
    ] })),
    http.post(`${base}/notes`, async ({ request }) => { posted = await request.json(); return HttpResponse.json({ id: 'note-1' }); }),
  );
  render(<LineMonitorPage tenantId="tenant-1" />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Linha do tempo' }));

  expect(await screen.findByText(/Removida · 29 ligações desde o pareamento, 29 hoje, saída edge-4/)).toBeInTheDocument();
  expect(screen.getByText(/PC ficou sem internet \(edge-4\)/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Nota da equipe'), { target: { value: 'Liguei o Business na 13' } });
  fireEvent.click(screen.getByRole('button', { name: 'Anotar' }));
  await vi.waitFor(() => expect(posted).toEqual({ body: 'Liguei o Business na 13' }));
});

it('mostra os aprendizados com a confiança de cada um', async () => {
  server.use(
    http.get(`${base}/now`, () => HttpResponse.json(now)),
    http.get(`${base}/learnings`, () => HttpResponse.json({
      id: 'run-1', period_start: '2026-10-29', period_end: '2026-11-27', sample: { lines: 21, lineDays: 120, calls: 1494, falls: 14, fallLines: 12 },
      findings: [{ key: 'calls_until_fall', question: 'Com quantas ligações as linhas caem?', answer: 'Metade das linhas caiu com até 29 ligações desde o pareamento.', action: 'Tratar 23 ligações como ponto de atenção.', confidence: 'reliable' }],
    })),
    http.get(`${base}/learnings/runs`, () => HttpResponse.json([{ id: 'run-1', trigger: 'nightly', period_start: '2026-10-29', period_end: '2026-11-27', computed_at: new Date().toISOString() }])),
  );
  render(<LineMonitorPage tenantId="tenant-1" />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Aprendizados' }));

  expect(await screen.findByText('Metade das linhas caiu com até 29 ligações desde o pareamento.')).toBeInTheDocument();
  expect(screen.getByText('Base sólida')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Recalcular agora' })).toBeInTheDocument();
});
