import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { ExperimentsPage } from './ExperimentsPage';

it('explica o que é um experimento e abre o formulário com os limites de segurança em linguagem simples', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/experiments', () => HttpResponse.json({ items: [] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/campaigns', () => HttpResponse.json({ items: [] })),
  );
  render(<ExperimentsPage tenantId="tenant-1" enabled />);
  expect(await screen.findByRole('heading', { name: 'Experimentos' })).toBeInTheDocument();
  expect(screen.getByText(/sem trocar a variante/i)).toBeInTheDocument();
  expect(screen.getByText('Nenhum experimento ainda')).toBeInTheDocument();

  await user.click(screen.getAllByRole('button', { name: 'Novo experimento' })[0]);
  expect(screen.getByText('Limites de segurança')).toBeInTheDocument();
  expect(screen.getByText('Chamadas falhando')).toBeInTheDocument();
  // Thresholds are edited as percentages, not fractions.
  expect(screen.getByLabelText('Limite de Chamadas falhando')).toHaveValue(25);
  expect(screen.getByText(/Nenhuma campanha em andamento agora/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Criar rascunho' })).toBeInTheDocument();
});

it('mostra o resultado lado a lado com a faixa provável e o estado dos limites', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/experiments', () => HttpResponse.json({ items: [{ id: 'exp-1', name: 'Retorno 30 vs 60', hypothesis: 'Retornar mais cedo atende mais.', primaryMetric: 'answer_rate', status: 'running', trafficPercent: 100, variantCount: 2, startedAt: '2026-09-01T12:00:00Z' }] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/campaigns', () => HttpResponse.json({ items: [] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/experiments/exp-1/report', () => HttpResponse.json({ primaryMetric: 'answer_rate', interpretation: 'Descritivo.', attribution: { method: 'sha256', stable: true }, guardrails: { minimumSampleSize: 30, evaluations: [{ metric: 'failure_rate', observedValue: .1, threshold: .25, sampleSize: 40, action: 'observed' }] }, variants: [
      { id: 'v1', key: 'control', name: 'Como é hoje', assignedCount: 40, primaryMetric: { value: .5, denominator: 40, uncertainty: { low: .35, high: .65 } }, observedDifferenceFromFirstVariant: 0 },
      { id: 'v2', key: 'treatment', name: 'Nova forma', assignedCount: 38, primaryMetric: { value: .6, denominator: 38, uncertainty: { low: .44, high: .74 } }, observedDifferenceFromFirstVariant: .1 },
    ] })),
  );
  render(<ExperimentsPage tenantId="tenant-1" enabled />);
  expect(await screen.findByText('Resultado até agora')).toBeInTheDocument();
  expect(screen.getByText(/Novos leads da campanha estão sendo divididos/)).toBeInTheDocument();
  expect(screen.getByText('Provavelmente entre 44% e 74%')).toBeInTheDocument();
  expect(screen.getByText(/\+10 pontos em relação a/)).toBeInTheDocument();
  expect(screen.getByText('Dentro do limite')).toBeInTheDocument();
});
