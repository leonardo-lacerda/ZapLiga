import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/setup';
import { McpKeysPanel } from './McpKeysPanel';
import { API } from './provisioning.fixtures';

const key = (overrides: Record<string, unknown> = {}) => ({
  id: 'k1', name: 'Claude do Leo', prefix: 'zpl_mcp_abcdefgh', scopes: ['mcp:read', 'mcp:operate'], status: 'active',
  userId: 'u1', userName: 'Leo', lastUsedAt: null, createdAt: '2026-11-23T10:00:00Z', revokedAt: null, ...overrides,
});

it('cria a chave, mostra o comando uma vez e revoga com confirmação', async () => {
  let keys: any[] = [];
  let created: any = null;
  const revoked: string[] = [];
  server.use(
    http.get(`${API}/mcp-keys`, () => HttpResponse.json({ items: keys })),
    http.post(`${API}/mcp-keys`, async ({ request }) => {
      created = await request.json();
      keys = [key({ name: created.name, scopes: created.scopes })];
      return HttpResponse.json({ ...keys[0], apiKey: 'zpl_mcp_SEGREDO' }, { status: 201 });
    }),
    http.post(`${API}/mcp-keys/:id/revoke`, ({ params }) => {
      revoked.push(String(params.id));
      keys = [key({ status: 'revoked' })];
      return HttpResponse.json(keys[0]);
    }),
  );
  render(<McpKeysPanel tenantId="tenant-1" />);

  expect(await screen.findByText('Nenhuma chave criada ainda.')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Nome da chave'), 'Claude do Leo');
  await userEvent.click(screen.getByRole('switch', { name: /apagar telefones/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Criar chave' }));

  const command = await screen.findByLabelText('Comando para conectar o Claude Code');
  expect(command.textContent).toMatch(/^claude mcp add --transport http zapliga .*\/api\/mcp --header "Authorization: Bearer zpl_mcp_SEGREDO"$/);
  expect(created).toEqual({ name: 'Claude do Leo', scopes: ['mcp:read', 'mcp:operate', 'mcp:destructive'] });

  await userEvent.click(screen.getByRole('button', { name: 'Já copiei' }));
  expect(screen.queryByText(/zpl_mcp_SEGREDO/)).not.toBeInTheDocument();

  await userEvent.click(await screen.findByRole('button', { name: 'Revogar Claude do Leo' }));
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revogar' }));
  expect(await screen.findByText('Revogada')).toBeInTheDocument();
  expect(revoked).toEqual(['k1']);
});
