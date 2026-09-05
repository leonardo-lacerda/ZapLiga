import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { BenchmarksPage } from './BenchmarksPage';

it('explica o bloqueio jurídico antes de mostrar benchmarks', async () => {
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-1/benchmarks/consent', () => HttpResponse.json({ status: 'not_set', policy: { termsVersion: 'benchmark-v1', purposes: ['aggregate_benchmarking'], minimumTenants: 5, consentApproved: false } })),
    http.get('http://localhost:3000/api/tenants/tenant-1/benchmarks/cohorts', () => HttpResponse.json({ status: 'pending_legal_approval', items: [] })),
  );
  render(<BenchmarksPage tenantId="tenant-1" enabled />);
  expect(await screen.findByText('Infraestrutura pronta, mas o texto jurídico e a finalidade ainda aguardam aprovação. Nenhum benchmark está sendo processado.')).toBeInTheDocument();
  expect(screen.queryByText('Participar do benchmark')).not.toBeInTheDocument();
});
