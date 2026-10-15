import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

type CrmIntegrationsPanelProps = { tenantId: string };

const copy = async (value: string) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.appendChild(input);
  try { input.select(); document.execCommand('copy'); } finally { document.body.removeChild(input); }
};

const formatDate = (value?: string | null) => value ? new Date(value).toLocaleString('pt-BR') : '';
const hostOf = (value?: string | null) => { try { return value ? new URL(value).host : ''; } catch { return ''; } };

/** Franco CRM: the leader generates the key the CRM uses to place calls through ZapLiga. */
export function CrmIntegrationsPanel({ tenantId }: CrmIntegrationsPanelProps) {
  const [integrations, setIntegrations] = useState<AnyRow[]>([]);
  const [name, setName] = useState('Franco CRM');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number>();
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try { setIntegrations(await json('/api/tenants/' + tenantId + '/crm-integrations')); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const showKey = (key: string, text: string) => { setApiKey(key); setCopied(false); setMessage(text); };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const result = await json('/api/tenants/' + tenantId + '/crm-integrations', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      showKey(result.api_key, 'Chave gerada. Copie agora: ela não será exibida novamente.');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const rotate = async (id: string) => {
    if (!window.confirm('Gerar uma nova chave? O Franco deixará de ligar até receber a chave nova.')) return;
    try { const result = await json('/api/tenants/' + tenantId + '/crm-integrations/' + id + '/rotate', { method: 'POST' }); showKey(result.api_key, 'Nova chave gerada. Atualize-a na caixa de entrada ZapLiga do Franco.'); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revogar esta integração? O Franco deixará de ligar e de administrar números imediatamente.')) return;
    try { await json('/api/tenants/' + tenantId + '/crm-integrations/' + id + '/revoke', { method: 'POST' }); setApiKey(''); setMessage('Integração revogada.'); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const handleCopy = async () => {
    await copy(apiKey);
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => { copyTimer.current = undefined; setCopied(false); }, 1800);
  };

  return <Panel className="integration-setup-panel crm-integration-panel">
    <div className="integration-setup-header"><div><span className="eyebrow">CRM</span><h2>Ligações pelo Franco</h2><p>Os agentes ligam para os leads direto do Franco usando as linhas WhatsApp desta empresa.</p></div><Badge tone="info">{integrations.filter((item) => item.status === 'active').length} ativas</Badge></div>

    {message && <div className="alert" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Fechar mensagem">×</button></div>}

    {apiKey ? <div className="integration-credentials" role="status">
      <div className="integration-credentials-head"><span className="integration-credentials-icon"><Icon name="check" size={16} /></span><div><strong>Chave da integração</strong><small>No Franco: Configurações → Caixas de entrada → Nova → ZapLiga, e cole esta chave.</small></div></div>
      <label>API key<div className="credential-row"><input readOnly value={apiKey} aria-label="API key da integração" /><Button type="button" variant="secondary" icon="copy" onClick={() => void handleCopy()}>{copied ? 'Copiado' : 'Copiar'}</Button></div></label>
      <Button type="button" variant="ghost" onClick={() => setApiKey('')}>Já copiei</Button>
    </div> : <form className="integration-create-form" onSubmit={(event) => void create(event)}>
      <label><span>Nome da integração</span><small>Ex.: Franco comercial</small><input aria-label="Nome da integração CRM" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required /></label>
      <div className="integration-destination-note"><Icon name="lock" size={15} /><span><strong>O Franco recebe telefone e nome de cada contato discado.</strong><small>A chave também permite ao Franco conectar linhas e vincular agentes. Cada agente vinculado ocupa um assento de SDR.</small></span></div>
      <div className="integration-form-footer"><span /><Button type="submit" disabled={busy || name.trim().length < 2} icon="unlock">{busy ? 'Gerando...' : 'Gerar chave'}</Button></div>
    </form>}

    <div className="integration-list">
      {integrations.map((integration) => <article className="integration-card" key={integration.id}>
        <div className="integration-card-title"><span className="integration-card-icon"><Icon name="plug" size={15} /></span><div><strong>{integration.name}</strong><small>{integration.api_key_prefix}…</small></div></div>
        <Badge tone={integration.status !== 'active' ? 'neutral' : integration.connected_at ? 'success' : 'warning'}>{integration.status !== 'active' ? 'Revogada' : integration.connected_at ? 'Conectada' : 'Aguardando o Franco'}</Badge>
        <div className="integration-stats">
          <span><small>Conectada em</small><strong>{integration.connected_at ? `${formatDate(integration.connected_at)}${hostOf(integration.webhook_url) ? ' · ' + hostOf(integration.webhook_url) : ''}` : 'Ainda não'}</strong></span>
          <span><small>Último uso</small><strong>{formatDate(integration.last_used_at) || 'Nunca'}</strong></span>
        </div>
        {integration.status === 'active' && <div className="panel-actions"><Button variant="ghost" onClick={() => void rotate(integration.id)}>Gerar nova chave</Button><Button variant="danger" onClick={() => void revoke(integration.id)}>Revogar</Button></div>}
      </article>)}
      {!integrations.length && <EmptyState title="Nenhuma integração com CRM" description="Gere uma chave acima para conectar o Franco." />}
    </div>
  </Panel>;
}
