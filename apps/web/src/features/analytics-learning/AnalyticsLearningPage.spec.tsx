import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { AnalyticsLearningPage } from './AnalyticsLearningPage';

it('responde a perguntas práticas, mostra a base de cada padrão e avisa que nada muda a fila', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/analytics/learning/insights', () => HttpResponse.json({ period: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }, minimumSampleSize: 20, status: 'ready', message: 'Insights descritivos disponíveis.', reliability: { score: 99, status: 'reliable', formulaVersion: 1 }, insights: [{ type: 'best_time', title: 'Melhor janela de atendimento', dimension: 'day_hour', dimensionValue: '1:10', metric: 'answerRate', value: .62, sampleSize: 24, denominator: 24, confidence: 'directional', explanation: 'Maior taxa observada.' }] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/analytics/learning/aggregates', () => HttpResponse.json({ items: [{ id: 'window-1', dimensionValue: '1:10', sampleSize: 24, smoothedMetrics: { answerRate: .62 } }] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/analytics/learning/monitor', () => HttpResponse.json({ stability: { status: 'stable', lines: [{ line: 'line-1' }], maxLineFailureDelta: .03 }, selectionBias: { status: 'observed', concentration: .62, retryShare: .12, dominantSource: 'automatico', warnings: [] } })),
  );
  render(<AnalyticsLearningPage tenantId="tenant-1" enabled />);
  expect(await screen.findByRole('heading', { name: 'Aprendizado da operação' })).toBeInTheDocument();
  expect(screen.getByText('Há dados suficientes para ler padrões')).toBeInTheDocument();
  expect(screen.getByText('Quando ligar?')).toBeInTheDocument();
  expect(screen.getAllByText('Segunda às 10h').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/24 tentativas/).length).toBeGreaterThan(0);
  expect(screen.getByText('Tendência inicial')).toBeInTheDocument();
  expect(screen.getByText('Só leitura')).toBeInTheDocument();
});

it('explica o que falta quando ainda não há volume suficiente', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/analytics/learning/insights', () => HttpResponse.json({ period: null, minimumSampleSize: 20, status: 'insufficient_data', message: 'Dados insuficientes.', reliability: { score: 0, status: 'insufficient_data' }, insights: [] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/analytics/learning/aggregates', () => HttpResponse.json({ items: [] })),
    http.get('http://localhost:3000/api/tenants/tenant-1/analytics/learning/monitor', () => HttpResponse.json({ stability: { status: 'insufficient_data', lines: [] }, selectionBias: { status: 'insufficient_data', warnings: [] } })),
  );
  render(<AnalyticsLearningPage tenantId="tenant-1" enabled />);
  expect(await screen.findByText('Ainda faltam dados para ler padrões com segurança')).toBeInTheDocument();
  expect(screen.getByText('Nenhum padrão para mostrar ainda')).toBeInTheDocument();
});
