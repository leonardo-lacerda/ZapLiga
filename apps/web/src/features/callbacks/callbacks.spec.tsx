import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { CallbacksPage } from './CallbacksPage';

it('keeps an overdue callback visible to its SDR', async () => {
  server.use(http.get('http://localhost:3000/api/callbacks', () => HttpResponse.json([{ id: 'cb1', lead_name: 'Maria', lead_phone: '5511999999999', due_at: new Date(Date.now() - 60_000).toISOString(), status: 'due', overdue: true }])));
  render(<CallbacksPage sdrs={[]} isSdr />);
  expect(await screen.findByText('Maria')).toBeInTheDocument();
  expect(screen.getByText('1 vencidos')).toBeInTheDocument();
});

it('explains when callbacks are disabled by feature flag', async () => {
  server.use(http.get('http://localhost:3000/api/callbacks', () => HttpResponse.json({
    statusCode: 409,
    message: { code: 'feature_disabled', feature: 'callbacks', message: 'Recurso temporariamente indisponivel para esta empresa' },
  }, { status: 409 })));
  render(<CallbacksPage sdrs={[]} isSdr={false} />);
  expect(await screen.findByText('Retornos ainda não liberados para esta empresa')).toBeInTheDocument();
});

it('skips the API when the feature is already known to be off', async () => {
  const spy = vi.fn();
  server.use(http.get('http://localhost:3000/api/callbacks', () => { spy(); return HttpResponse.json([]); }));
  render(<CallbacksPage sdrs={[]} isSdr={false} featureEnabled={false} />);
  expect(await screen.findByText('Retornos ainda não liberados para esta empresa')).toBeInTheDocument();
  expect(spy).not.toHaveBeenCalled();
});
