import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { apiBaseUrl } from '../../services/api';
import { createMcpKey, fetchMcpKeys, revokeMcpKey } from './provisioning.api';
import { formatDateTime } from './provisioning.labels';
import type { CreatedMcpKey, McpKey } from './provisioning.types';
import { useDialog } from './useDialog';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const mcpCommand = (apiKey: string) =>
  `claude mcp add --transport http zapliga ${apiBaseUrl.replace(/\/$/, '')}/api/mcp --header "Authorization: Bearer ${apiKey}"`;

/**
 * "Chave para o Claude": o Claude Code opera telefones, cadastros e linhas pelo MCP do ZapLiga
 * (docs/mcp.md). Cada chave age em nome de quem a criou; aparece uma vez, com o comando pronto.
 */
export function McpKeysPanel({ tenantId }: { tenantId: string }) {
  const [keys, setKeys] = useState<McpKey[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [destructive, setDestructive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedMcpKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [dialog, ask] = useDialog();

  const load = useCallback(async () => {
    try { setKeys(await fetchMcpKeys(tenantId)); setError(''); }
    catch (e) { setError(errorText(e)); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setCreating(true); setError(''); setCopied(false);
    try {
      const scopes = ['mcp:read', 'mcp:operate', ...(destructive ? ['mcp:destructive'] : [])];
      setCreated(await createMcpKey(tenantId, { name: name.trim(), scopes }));
      setName(''); setDestructive(false);
      void load();
    } catch (e) { setError(errorText(e)); }
    finally { setCreating(false); }
  };

  const revoke = async (key: McpKey) => {
    if (!(await ask({ title: `Revogar a chave ${key.name}?`, confirmLabel: 'Revogar', danger: true,
      body: 'O Claude que usa esta chave para de conseguir operar os telefones na hora.' }))) return;
    try { await revokeMcpKey(tenantId, key.id); void load(); }
    catch (e) { setError(errorText(e)); }
  };

  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  };

  return <Panel className="provisioning-mcp">
    {dialog}
    <SectionHeader title="Chave para o Claude (MCP)"
      description="Deixa o Claude Code ver e operar os telefones, os cadastros e as linhas, em seu nome. Ele pede sua aprovação a cada ação; telefones ligados por ele desligam sozinhos ao terminar." />
    {error && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{error}</span></div>}

    {created && <div className="alert alert-warning provisioning-mcp-created" role="status">
      <Icon name="alert" size={17} />
      <div>
        <strong>Copie agora: a chave não aparece de novo.</strong>
        <p>No terminal, rode:</p>
        <code aria-label="Comando para conectar o Claude Code">{mcpCommand(created.apiKey)}</code>
        <div className="provisioning-inline-actions">
          <Button icon="copy" onClick={() => void copy(mcpCommand(created.apiKey))}>{copied ? 'Copiado' : 'Copiar comando'}</Button>
          <Button variant="ghost" onClick={() => setCreated(null)}>Já copiei</Button>
        </div>
      </div>
    </div>}

    <div className="provisioning-mcp-form">
      <label className="field"><span>Nome da chave</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Claude do Leo" maxLength={80} />
      </label>
      <label className="provisioning-switch">
        <input type="checkbox" role="switch" checked={destructive} onChange={(event) => setDestructive(event.target.checked)} />
        <span>Também pode apagar telefones e gerar aparelho novo</span>
      </label>
      <Button icon="plus" onClick={() => void create()} disabled={creating || name.trim().length < 2}>{creating ? 'Criando…' : 'Criar chave'}</Button>
    </div>

    {keys && keys.length > 0 && <ul className="provisioning-recent-list">
      {keys.map((key) => <li key={key.id}>
        <div>
          <strong>{key.name}</strong>
          <small>{key.userName ?? 'Usuário removido'} · {key.prefix}… · {key.scopes.includes('mcp:destructive') ? 'pode apagar' : 'sem apagar'}</small>
          <small>{key.lastUsedAt ? `Usada ${formatDateTime(key.lastUsedAt)}` : 'Nunca usada'}</small>
        </div>
        <Badge tone={key.status === 'active' ? 'success' : 'neutral'}>{key.status === 'active' ? 'Ativa' : 'Revogada'}</Badge>
        {key.status === 'active'
          ? <Button variant="ghost" icon="close" onClick={() => void revoke(key)} aria-label={`Revogar ${key.name}`}>Revogar</Button>
          : <span />}
      </li>)}
    </ul>}
    {keys && !keys.length && <p className="subtle">Nenhuma chave criada ainda.</p>}
  </Panel>;
}
