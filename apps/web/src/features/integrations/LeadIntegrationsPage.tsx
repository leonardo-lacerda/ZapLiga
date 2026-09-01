import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

type LeadIntegrationsPageProps = { tenantId: string; folders: AnyRow[] };
type Credentials = { api_key: string; signing_secret: string; webhook_url: string } | null;

const copy = async (value: string) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.appendChild(input);
  try { input.select(); document.execCommand('copy'); } finally { document.body.removeChild(input); }
};

const formatDate = (value?: string) => value ? new Date(value).toLocaleString('pt-BR') : 'Nenhum recebimento';
const absoluteUrl = (value: string) => /^https?:\/\//i.test(value) ? value : new URL(value, window.location.origin).toString();
const curlExample = [
  'curl -X POST \\',
  '  https://app.zapliga.com.br/api/v1/lead-integrations/{public_id}/leads \\',
  '  -H "Authorization: Bearer {api_key}" \\',
  '  -H "Content-Type: application/json" \\',
  "  -d '{\"name\":\"Ana Souza\",\"phone\":\"+5511999999999\",\"email\":\"ana@empresa.com\"}'",
].join('\n');

export function LeadIntegrationsPage({ tenantId, folders }: LeadIntegrationsPageProps) {
  const [integrations, setIntegrations] = useState<AnyRow[]>([]);
  const [events, setEvents] = useState<AnyRow[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState<Credentials>(null);
  const [copied, setCopied] = useState('');
  const [form, setForm] = useState({ name: '', integrationType: 'webhook', defaultFolderId: '', duplicatePolicy: 'update_existing', defaultPriority: '0' });

  const activeFolders = useMemo(() => folders.filter((folder) => folder.is_active), [folders]);
  const activeIntegrations = integrations.filter((item) => item.status === 'active');
  const acceptedEvents = events.filter((item) => ['accepted', 'updated'].includes(item.status)).length;
  const failedEvents = events.filter((item) => ['failed', 'dead_letter', 'rejected'].includes(item.status)).length;
  const lastEvent = events[0];

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [nextIntegrations, nextEvents] = await Promise.all([
        json('/api/tenants/' + tenantId + '/lead-integrations'),
        json('/api/tenants/' + tenantId + '/lead-ingestion/events?limit=20&offset=0'),
      ]);
      setIntegrations(nextIntegrations);
      setEvents(nextEvents.items ?? []);
      setForm((current) => ({ ...current, defaultFolderId: current.defaultFolderId || activeFolders[0]?.id || '' }));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [tenantId, activeFolders]);

  useEffect(() => { void load(); }, [load]);

  const handleCopy = async (label: string, value: string) => {
    await copy(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => current === label ? '' : current), 1800);
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await json('/api/tenants/' + tenantId + '/lead-integrations', { method: 'POST', body: JSON.stringify({ ...form, defaultPriority: Number(form.defaultPriority) }) });
      setCredentials({ api_key: result.api_key, signing_secret: result.signing_secret, webhook_url: absoluteUrl(result.webhook_url) });
      setForm({ name: '', integrationType: 'webhook', defaultFolderId: activeFolders[0]?.id || '', duplicatePolicy: 'update_existing', defaultPriority: '0' });
      setMessage('Integração criada. Salve as credenciais agora: elas não serão exibidas novamente.'); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const rotate = async (id: string) => {
    if (!window.confirm('Rotacionar as credenciais? A credencial atual deixará de funcionar imediatamente.')) return;
    try { const result = await json('/api/tenants/' + tenantId + '/lead-integrations/' + id + '/rotate-secret', { method: 'POST' }); setCredentials({ api_key: result.api_key, signing_secret: result.signing_secret, webhook_url: absoluteUrl(result.webhook_url) }); setMessage('Credenciais rotacionadas.'); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revogar esta integração? Novos leads deixarão de ser aceitos.')) return;
    try { await json('/api/tenants/' + tenantId + '/lead-integrations/' + id + '/revoke', { method: 'POST' }); setMessage('Integração revogada.'); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  return <div className="integration-page">
    <div className="integration-hero">
      <div className="integration-hero-copy">
        <span className="eyebrow">ENTRADAS AUTOMÁTICAS</span>
        <h1>Integrações de leads</h1>
        <p>Conecte seu CRM, formulário ou automação e coloque novos contatos na fila de discagem sem trabalho manual.</p>
        <div className="integration-hero-points">
          <span><Icon name="check" size={13} /> Fila automática</span>
          <span><Icon name="unlock" size={13} /> Credenciais seguras</span>
          <span><Icon name="chart" size={13} /> Eventos rastreáveis</span>
        </div>
      </div>
      <div className="integration-hero-status">
        <div className="integration-hero-status-top"><span className="integration-pulse" /> API pronta</div>
        <strong>{activeIntegrations.length}</strong>
        <small>{activeIntegrations.length === 1 ? 'integração ativa' : 'integrações ativas'}</small>
        <div className="integration-hero-meter"><span style={{ width: activeIntegrations.length ? '100%' : '18%' }} /></div>
        <small>{lastEvent ? 'Último evento ' + formatDate(lastEvent.received_at) : 'Comece criando sua primeira integração'}</small>
      </div>
    </div>

    {message && <div className="alert" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Fechar mensagem">×</button></div>}

    <div className="integration-summary-grid">
      <article><span className="integration-summary-icon integration-summary-blue"><Icon name="plug" size={16} /></span><div><small>Integrações ativas</small><strong>{activeIntegrations.length}</strong><span>prontas para receber</span></div></article>
      <article><span className="integration-summary-icon integration-summary-green"><Icon name="check" size={16} /></span><div><small>Eventos processados</small><strong>{acceptedEvents}</strong><span>nos últimos eventos</span></div></article>
      <article><span className="integration-summary-icon integration-summary-orange"><Icon name="alert" size={16} /></span><div><small>Precisam de atenção</small><strong>{failedEvents}</strong><span>falhas ou rejeições</span></div></article>
      <article><span className="integration-summary-icon integration-summary-purple"><Icon name="archive" size={16} /></span><div><small>Destino configurado</small><strong>{activeFolders.length}</strong><span>pastas disponíveis</span></div></article>
    </div>

    <div className="integration-main-grid">
      <Panel className="integration-create-panel">
        <div className="integration-panel-intro"><div className="integration-step-number">01</div><div><span className="eyebrow">PRIMEIRO PASSO</span><h2>Crie uma entrada</h2><p>Defina onde os contatos vão cair e gere uma credencial exclusiva.</p></div></div>
        <form className="integration-create-form" onSubmit={(event) => void create(event)}>
          <label><span>Nome da integração</span><small>Ex.: HubSpot comercial</small><input placeholder="Nome da integração" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} minLength={2} required /></label>
          <label><span>Como os leads chegarão?</span><small>Você pode alterar depois no seu provedor</small><select aria-label="Tipo de integração" value={form.integrationType} onChange={(event) => setForm({ ...form, integrationType: event.target.value })}><option value="webhook">Webhook</option><option value="api">API</option><option value="automation">Automação (n8n, Make, Zapier)</option></select></label>
          <label><span>Pasta de destino</span><small>Novos leads entram nesta fila</small><select aria-label="Pasta padrão" value={form.defaultFolderId} onChange={(event) => setForm({ ...form, defaultFolderId: event.target.value })} required><option value="">Selecione uma pasta</option>{activeFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
          <label><span>Quando encontrar duplicado?</span><small>Regra para o mesmo telefone</small><select aria-label="Duplicatas" value={form.duplicatePolicy} onChange={(event) => setForm({ ...form, duplicatePolicy: event.target.value })}><option value="update_existing">Atualizar o lead existente</option><option value="ignore_duplicate">Ignorar o novo lead</option><option value="reject_duplicate">Rejeitar o evento</option></select></label>
          <label className="integration-priority-field"><span>Prioridade padrão</span><small>Maior valor, maior prioridade</small><input type="number" aria-label="Prioridade padrão" min="-100" max="100" value={form.defaultPriority} onChange={(event) => setForm({ ...form, defaultPriority: event.target.value })} /></label>
          <div className="integration-form-footer"><span><Icon name="unlock" size={13} /> A chave será mostrada uma única vez</span><Button disabled={busy || !activeFolders.length} icon="plus">{busy ? 'Criando...' : 'Gerar credenciais'}</Button></div>
        </form>
        {!activeFolders.length && <p className="form-hint">Ative uma pasta de leads antes de criar uma entrada automática.</p>}
        {credentials && <div className="integration-credentials" role="status"><div className="integration-credentials-head"><span className="integration-credentials-icon"><Icon name="check" size={16} /></span><div><strong>Credenciais prontas</strong><small>Copie e armazene agora. O segredo não será mostrado novamente.</small></div></div><label>URL do webhook<div className="credential-row"><input readOnly value={credentials.webhook_url} /><Button type="button" variant="secondary" icon="copy" onClick={() => void handleCopy('webhook', credentials.webhook_url)}>{copied === 'webhook' ? 'Copiado' : 'Copiar'}</Button></div></label><label>API key<div className="credential-row"><input readOnly value={credentials.api_key} /><Button type="button" variant="secondary" icon="copy" onClick={() => void handleCopy('key', credentials.api_key)}>{copied === 'key' ? 'Copiado' : 'Copiar'}</Button></div></label><label>Segredo HMAC<div className="credential-row"><input readOnly value={credentials.signing_secret} /><Button type="button" variant="secondary" icon="copy" onClick={() => void handleCopy('secret', credentials.signing_secret)}>{copied === 'secret' ? 'Copiado' : 'Copiar'}</Button></div></label></div>}
      </Panel>

      <Panel className="integration-tutorial-panel">
        <div className="integration-panel-intro"><div className="integration-step-number integration-step-number-dark">?</div><div><span className="eyebrow">GUIA RÁPIDO</span><h2>Como colocar para funcionar</h2><p>Do primeiro clique ao lead na fila em quatro passos.</p></div></div>
        <ol className="integration-tutorial-steps">
          <li><span>1</span><div><strong>Crie a integração</strong><small>Escolha um nome e a pasta de destino ao lado.</small></div></li>
          <li><span>2</span><div><strong>Configure seu provedor</strong><small>Use a URL do webhook gerada no CRM ou automação.</small></div></li>
          <li><span>3</span><div><strong>Envie o contato</strong><small>Inclua nome e telefone. E-mail e origem são opcionais.</small></div></li>
          <li><span>4</span><div><strong>Acompanhe a entrada</strong><small>O evento aparece aqui e o lead segue para a fila configurada.</small></div></li>
        </ol>
        <div className="integration-tutorial-example"><div className="integration-tutorial-example-head"><span>Exemplo de envio</span><Badge tone="info">POST</Badge></div><pre>{curlExample}</pre><button className="integration-copy-example" type="button" onClick={() => void handleCopy('example', curlExample)}>{copied === 'example' ? 'Exemplo copiado' : 'Copiar exemplo'}</button></div>
        <div className="integration-tutorial-note"><Icon name="alert" size={15} /><span><strong>Importante:</strong> nunca compartilhe a API key em páginas públicas. Para webhooks, valide também a assinatura HMAC.</span></div>
      </Panel>
    </div>

    <Panel><SectionHeader eyebrow="CONTROLE" title="Integrações configuradas" description="Veja o destino, a saúde e as credenciais de cada entrada." action={<Badge tone="info">{integrations.length} no total</Badge>} /><div className="integration-list">{integrations.map((integration) => <article className="integration-card" key={integration.id}><div className="integration-card-title"><span className="integration-card-icon"><Icon name="plug" size={15} /></span><div><strong>{integration.name}</strong><small>{integration.integration_type} · {folders.find((folder) => folder.id === integration.default_folder_id)?.name ?? 'Pasta removida'}</small></div></div><Badge tone={integration.status === 'active' ? 'success' : 'neutral'}>{integration.status === 'active' ? 'Ativa' : 'Revogada'}</Badge><div className="integration-stats"><span><small>Último recebimento</small><strong>{formatDate(integration.last_received_at)}</strong></span><span><small>Prioridade</small><strong>{integration.default_priority}</strong></span></div>{integration.status === 'active' && <div className="panel-actions"><Button variant="ghost" onClick={() => void rotate(integration.id)}>Rotacionar credenciais</Button><Button variant="danger" onClick={() => void revoke(integration.id)}>Revogar</Button></div>}</article>)}{!integrations.length && <EmptyState title="Nenhuma integração configurada" description="Crie uma entrada acima para começar a receber leads automaticamente." />}</div></Panel>

    <Panel><SectionHeader eyebrow="OBSERVABILIDADE" title="Atividade recente" description="Cada evento recebido fica registrado para facilitar o diagnóstico." action={lastEvent && <span className="integration-last-update"><span className="integration-pulse" /> Atualizado agora</span>} /><div className="integration-events">{events.map((item) => <div className="integration-event-row" key={item.id}><span className={'integration-event-dot integration-event-' + item.status} /><div><strong>{item.integration_name}</strong><small>{item.external_event_id || item.id}</small></div><Badge tone={['accepted', 'updated'].includes(item.status) ? 'success' : item.status === 'duplicate' ? 'neutral' : ['failed', 'dead_letter', 'rejected'].includes(item.status) ? 'warning' : 'info'}>{item.status}</Badge><time>{formatDate(item.received_at)}</time></div>)}{!events.length && <EmptyState title="Nenhum evento recebido" description="Quando seu CRM enviar o primeiro lead, o histórico aparecerá aqui." />}</div></Panel>
  </div>;
}
