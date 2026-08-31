import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { CallbacksPage } from './CallbacksPage';

it('keeps an overdue callback visible to its SDR', async () => {
  server.use(http.get('http://localhost:3000/api/callbacks', () => HttpResponse.json([{ id: 'cb1', lead_name: 'Maria', lead_phone: '5511999999999', due_at: new Date(Date.now() - 60_000).toISOString(), status: 'due', overdue: true }])));
  render(<CallbacksPage sdrs={[]} isSdr />);
  expect(await screen.findByText('Maria')).toBeInTheDocument();
  expect(screen.getByText('1 vencidos')).toBeInTheDocument();
});
