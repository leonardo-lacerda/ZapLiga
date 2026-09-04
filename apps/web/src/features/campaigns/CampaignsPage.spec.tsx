import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { CampaignsPage } from './CampaignsPage';

const folders = [{ id: 'folder-a', name: 'Inbound', is_active: true, lead_count: 12 }];
const sdrs = [{ id: 'sdr-a', name: 'Ana', is_active: true, available: true }];
const numbers = [{ id: 'number-a', label: 'Linha principal', status: 'connected' }];

it('guides a leader through the six-step campaign wizard and creates a draft', async () => {
  const user = userEvent.setup();
  let saved: any;
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-a/campaigns', () => HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 })),
    http.post('http://localhost:3000/api/tenants/tenant-a/campaigns', async ({ request }) => { saved = await request.json(); return HttpResponse.json({ id: 'campaign-a', ...saved, status: 'draft', lock_version: 0 }); }),
    http.get('http://localhost:3000/api/tenants/tenant-a/campaigns/campaign-a', () => HttpResponse.json({ id: 'campaign-a', name: 'Outbound enterprise', status: 'draft', lock_version: 0 })),
    http.get('http://localhost:3000/api/tenants/tenant-a/campaigns/campaign-a/versions', () => HttpResponse.json([])),
  );
  render(<CampaignsPage tenantId="tenant-a" folders={folders} sdrs={sdrs} numbers={numbers} />);
  await user.click(screen.getByRole('button', { name: 'Nova campanha' }));
  await user.type(screen.getByPlaceholderText('Ex.: Reativação inbound Q4'), 'Outbound enterprise');
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await user.click(screen.getByRole('button', { name: /Inbound/ }));
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  await user.click(screen.getByRole('button', { name: 'Criar rascunho' }));
  await waitFor(() => expect(saved.name).toBe('Outbound enterprise'));
  expect(saved.folderId).toBe('folder-a');
  expect(saved.sdrIds).toEqual(['sdr-a']);
  expect(saved.numberIds).toEqual(['number-a']);
  expect(await screen.findByText('Campanha criada como rascunho.')).toBeInTheDocument();
});

it('renders version history and requests a field-level diff', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('http://localhost:3000/api/tenants/tenant-a/campaigns', () => HttpResponse.json({ items: [{ id: 'campaign-a', name: 'Enterprise', status: 'ready', folder_name: 'Inbound', lead_count: 4, current_version: 2 }] })),
    http.get('http://localhost:3000/api/tenants/tenant-a/campaigns/campaign-a', () => HttpResponse.json({ id: 'campaign-a', name: 'Enterprise', status: 'ready', folder_name: 'Inbound', current_version: 2, lock_version: 3, current_version_hash: 'sha256-hash', draft_config: {} })),
    http.get('http://localhost:3000/api/tenants/tenant-a/campaigns/campaign-a/versions', () => HttpResponse.json([{ id: 'v2', version: 2, config_hash: 'hash-two', change_reason: 'Ajuste de ritmo', created_at: '2026-09-04T12:00:00Z' }, { id: 'v1', version: 1, config_hash: 'hash-one', change_reason: 'Publicação', created_at: '2026-09-03T12:00:00Z' }])),
    http.get('http://localhost:3000/api/tenants/tenant-a/campaigns/campaign-a/diff', () => HttpResponse.json({ from: 1, to: 2, changes: [{ path: 'rules.maxCallsPerMinute', before: 10, after: 20 }] })),
  );
  render(<CampaignsPage tenantId="tenant-a" folders={folders} sdrs={sdrs} numbers={numbers} />);
  await user.click(await screen.findByRole('button', { name: /Enterprise/ }));
  expect(await screen.findByText('Ajuste de ritmo')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Comparar últimas' }));
  expect(await screen.findByText('rules.maxCallsPerMinute')).toBeInTheDocument();
});
