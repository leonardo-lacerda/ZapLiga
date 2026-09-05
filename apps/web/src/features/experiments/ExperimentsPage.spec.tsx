import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { ExperimentsPage } from './ExperimentsPage';

it('explica a definição obrigatória e a parada segura do experimento', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/experiments', () => HttpResponse.json({ items: [] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/campaigns', () => HttpResponse.json({ items: [] })),
  );
  render(<ExperimentsPage tenantId="tenant-1" enabled />);
  expect(await screen.findByRole('heading', { name: 'Testar melhorias com segurança' })).toBeInTheDocument();
  expect(screen.getByText('Guardrails obrigatórios')).toBeInTheDocument();
  expect(screen.getByText(/sem trocar a variante/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Criar rascunho' })).toBeInTheDocument();
});
