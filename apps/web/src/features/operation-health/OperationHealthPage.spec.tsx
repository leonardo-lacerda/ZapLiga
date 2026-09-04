import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, vi } from 'vitest';
import { server } from '../../test/setup';
import { OperationHealthPage } from './OperationHealthPage';

afterEach(() => vi.useRealTimers());

it('mostra score, evidências, tendência e drilldown da linha', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/operation-health', () => HttpResponse.json({ score: 78, state: 'attention', formulaVersion: 'v1', internalScoreNotice: 'Score interno do ZapLiga', nextSafeAction: 'Revise a fila', collectedAt: new Date().toISOString(), sampleSize: { attempts: 20, numbers: 2 }, components: [{ code: 'connectivity', score: 100, weight: .25, numerator: 2, denominator: 2 }], reasonCodes: ['callbacks_due'], evidence: { capacity: { configured: 4, active: 1, available: 3, nextReleaseAt: null }, queue: { ready: 4, waiting: 2, dueCallbacks: 1 } }, trend: { direction: 'up', delta: 4 } })),
    http.get('http://localhost:3000/api/tenants/tenant-1/operation-health/history', () => HttpResponse.json({ items: [{ id: 'snapshot-1', score: 74, state: 'attention', formulaVersion: 'v1', createdAt: new Date().toISOString(), components: [], reasonCodes: [], evidence: {} }] })),
    http.get('http://localhost:3000/api/numbers', () => HttpResponse.json({ items: [{ id: 'number-1', label: 'Linha principal', status: 'connected' }], total: 1 })),
    http.get('http://localhost:3000/api/tenants/tenant-1/numbers/number-1/health', () => HttpResponse.json({ numberId: 'number-1', label: 'Linha principal', status: 'connected', score: 92, state: 'healthy', formulaVersion: 'v1', nextSafeAction: 'Nenhuma intervenção imediata', collectedAt: new Date().toISOString(), protection: { cooldown: false, quarantine: false, nextReleaseAt: null }, components: [{ code: 'connectivity', score: 100, weight: .25, numerator: 1, denominator: 1 }] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/numbers/number-1/health/events', () => HttpResponse.json({ items: [{ id: 'event-1', eventType: 'reconnected', actorType: 'automatic', occurredAt: new Date().toISOString(), metadata: {} }] })),
  );

  render(<OperationHealthPage tenantId="tenant-1" enabled />);

  expect(await screen.findByRole('heading', { name: 'Saúde da operação' })).toBeInTheDocument();
  expect(screen.getByText('Revise a fila')).toBeInTheDocument();
  expect(screen.getByText('Tendência da saúde')).toBeInTheDocument();
  expect(screen.getByText('Linha principal')).toBeInTheDocument();
  expect(await screen.findByText('Automático', { exact: false })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Linha principal/i }));
  expect(await screen.findByText('Nenhuma intervenção imediata')).toBeInTheDocument();
});
