import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { BenchmarksPage } from './BenchmarksPage';

it('explica em linguagem simples que o benchmark ainda está em preparação e não oferece participação', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/benchmarks/consent', () => HttpResponse.json({ status: 'not_set', policy: { termsVersion: 'benchmark-v1', purposes: ['aggregate_benchmarking'], minimumTenants: 5, consentApproved: false } })),
    http.get('http://localhost:3000/api/tenants/tenant-1/benchmarks/cohorts', () => HttpResponse.json({ status: 'pending_legal_approval', items: [] })),
  );
  render(<BenchmarksPage tenantId="tenant-1" enabled />);
  expect(await screen.findByText('O benchmark ainda está em preparação')).toBeInTheDocument();
  expect(screen.getByText(/nenhum dado de nenhuma empresa é usado/)).toBeInTheDocument();
  expect(screen.queryByText('Participar do benchmark')).not.toBeInTheDocument();
});

it('mostra a faixa de empresas parecidas em palavras quando a empresa participa', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/benchmarks/consent', () => HttpResponse.json({ status: 'opt_in', policy: { termsVersion: 'benchmark-v1', purposes: ['aggregate_benchmarking'], minimumTenants: 5, minimumCallsPerTenant: 20, consentApproved: true } })),
    http.get('http://localhost:3000/api/tenants/tenant-1/benchmarks/cohorts', () => HttpResponse.json({ status: 'ready', period: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' }, items: [{ cohortKey: 'c1', teamSizeBand: '1_5', volumeBand: '100_499', eligibleTenants: 7, calls: 1200, answerRate: { p25: .3, median: .42, p75: .55, trimmedMean: .41 } }] })),
  );
  render(<BenchmarksPage tenantId="tenant-1" enabled />);
  expect(await screen.findByText('Sua empresa participa do benchmark')).toBeInTheDocument();
  expect(screen.getByText('Equipes de 1 a 5 pessoas')).toBeInTheDocument();
  expect(screen.getByText(/Metade das empresas deste grupo atende entre 30% e 55%/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sair do benchmark' })).toBeInTheDocument();
});
