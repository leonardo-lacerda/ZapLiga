import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel } from '../../components/ui';
import { apiBaseUrl, json } from '../../services/api';
import type { AnyRow } from '../../types';

type LeadIntegrationsPageProps = { tenantId: string; folders: AnyRow[] };
type Credentials = { api_key: string; signing_secret: string; webhook_url: string } | null;
type SetupStep = 1 | 2 | 3 | 4;

const copy = async (value: string) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.appendChild(input);
  try { input.select(); document.execCommand('copy'); } finally { document.body.removeChild(input); }
};

const formatDate = (value?: string) => value ? new Date(value).toLocaleString('pt-BR') : 'Nenhum recebimento';
const absoluteUrl = (value: string) => /^https?:\/\//i.test(value) ? value : new URL(value, apiBaseUrl.replace(/\/+$/, '') + '/').toString();
const curlExample = [
  'curl -X POST \\',
  '  ' + apiBaseUrl.replace(/\/+$/, '') + '/api/v1/lead-integrations/{public_id}/leads \\',
  '  -H "Authorization: Bearer {api_key}" \\',
  '  -H "Content-Type: application/json" \\',
  "  -d '{\"name\":\"Ana Souza\",\"phone\":\"+5511999999999\",\"email\":\"ana@empresa.com\"}'",
].join('\n');

const typeOptions = [
  { value: 'webhook', icon: 'plug', title: 'Webhook', description: 'Ideal para receber leads assim que algo acontece no seu CRM.' },
  { value: 'api', icon: 'chart', title: 'API', description: 'Para enviar contatos sob demanda usando uma requisição HTTP.' },
  { value: 'automation', icon: 'sparkles', title: 'Automação', description: 'Conecte n8n, Make, Zapier ou outra ferramenta de fluxo.' },
];

export function LeadIntegrationsPage({ tenantId, folders }: LeadIntegrationsPageProps) {
  const [integrations, setIntegrations] = useState<AnyRow[]>([]);
  const [campaigns, setCampaigns] = useState<AnyRow[]>([]);
  const [events, setEvents] = useState<AnyRow[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState<Credentials>(null);
  const [copied, setCopied] = useState('');
  const copyTimer = useRef<number>();
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);
  const [step, setStep] = useState<SetupStep>(1);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [form, setForm] = useState({ name: '', integrationType: 'webhook', defaultFolderId: '', campaignId: '', duplicatePolicy: 'update_existing', defaultPriority: '0' });

  const activeFolders = useMemo(() => folders.filter((folder) => folder.is_active), [folders]);
  const activeIntegrations = integrations.filter((item) => item.status === 'active');
  const lastEvent = events[0];

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [nextIntegrations, nextEvents] = await Promise.all([
        json('/api/tenants/' + tenantId + '/lead-integrations'),
        json('/api/tenants/' + tenantId + '/lead-ingestion/events?limit=20&offset=0'),
      ]);
      const campaignPage = await json('/api/tenants/' + tenantId + '/campaigns?status=running&limit=100&offset=0').catch(() => ({ items: [] }));
      setIntegrations(nextIntegrations);
      setCampaigns(campaignPage.items ?? []);
      setEvents(nextEvents.items ?? []);
      setForm((current) => ({ ...current, defaultFolderId: current.defaultFolderId || activeFolders[0]?.id || '' }));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [tenantId, activeFolders]);

  useEffect(() => { void load(); }, [load]);

  const handleCopy = async (label: string, value: string) => {
    await copy(value);
    setCopied(label);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => { copyTimer.current = undefined; setCopied((current) => current === label ? '' : current); }, 1800);
  };

  const goNext = () => {
    if (step === 1) { setStep(2); return; }
    if (step === 2) {
      if (form.name.trim().length < 2) { setMessage('Informe um nome para a integração.'); return; }
      if (!form.defaultFolderId) { setMessage('Escolha a pasta que receberá os novos leads.'); return; }
      setStep(3); setMessage(''); return;
    }
    if (step === 3) { setStep(4); setMessage(''); }
  };

  const goBack = () => {
    setMessage('');
    setStep((current) => Math.max(1, current - 1) as SetupStep);
  };

  const resetSetup = () => {
    setCredentials(null);
    setMessage('');
    setStep(1);
    setForm({ name: '', integrationType: 'webhook', defaultFolderId: activeFolders[0]?.id || '', campaignId: '', duplicatePolicy: 'update_existing', defaultPriority: '0' });
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (step < 4) { goNext(); return; }
    setBusy(true); setMessage('');
    try {
      const result = await json('/api/tenants/' + tenantId + '/lead-integrations', { method: 'POST', body: JSON.stringify({ ...form, campaignId: form.campaignId || null, defaultPriority: Number(form.defaultPriority) }) });
      setCredentials({ api_key: result.api_key, signing_secret: result.signing_secret, webhook_url: absoluteUrl(result.webhook_url) });
      setMessage('Integração criada. Salve as credenciais agora: elas não serão exibidas novamente.');
      await load();
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

  const stepTitle = ['Escolha a origem', 'Configure o destino', 'Ajuste as regras', 'Finalize com segurança'][step - 1];
  const stepDescription = ['De onde os novos leads serão enviados?', 'Escolha como a entrada será identificada e para qual fila ela irá.', 'Essas opções são opcionais e podem ser ajustadas para a sua operação.', 'Gere e copie as credenciais para conectar seu provedor.'][step - 1];

  return <div className="integration-page">
    <div className="integration-page-heading">
      <div><span className="eyebrow">ENTRADAS</span><h1>Integrações de leads</h1><p>Receba novos contatos automaticamente e coloque-os na fila certa.</p></div>
      <div className="integration-heading-side"><Badge tone="info">{activeIntegrations.length} ativas</Badge><button className="integration-help-button" type="button" onClick={() => setShowTutorial((current) => !current)}><Icon name="note" size={13} /> {showTutorial ? 'Ocultar guia' : 'Como funciona?'}</button></div>
    </div>

    {message && <div className="alert" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Fechar mensagem">×</button></div>}

    <Panel className="integration-setup-panel">
      <div className="integration-setup-header"><div><span className="eyebrow">NOVA INTEGRAÇÃO</span><h2>{stepTitle}</h2><p>{stepDescription}</p></div><span className="integration-setup-count">Etapa {step} de 4</span></div>
      <div className="integration-stepper" aria-label="Progresso da configuração">{['Origem', 'Destino', 'Regras', 'Credenciais'].map((label, index) => { const itemStep = index + 1; return <div className={itemStep <= step ? 'is-active' : ''} key={label}><span>{itemStep < step ? <Icon name="check" size={12} /> : itemStep}</span><small>{label}</small></div>; })}</div>

      <form onSubmit={(event) => void create(event)}>
        {step === 2 && <label className="integration-campaign-select"><span>Campanha de execução</span><small>Opcional · apenas campanhas publicadas e em operação.</small><select aria-label="Campanha de execução" value={form.campaignId} onChange={(event) => setForm({ ...form, campaignId: event.target.value })}><option value="">Usar fila legada</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></label>}
        {step === 1 && <div className="integration-source-grid">{typeOptions.map((option) => <button className={'integration-source-card' + (form.integrationType === option.value ? ' is-selected' : '')} type="button" aria-pressed={form.integrationType === option.value} key={option.value} onClick={() => setForm({ ...form, integrationType: option.value })}><span className="integration-source-icon"><Icon name={option.icon} size={17} /></span><span><strong>{option.title}</strong><small>{option.description}</small></span><span className="integration-source-radio" /></button>)}</div>}

        {step === 2 && <div className="integration-create-form"><label><span>Nome da integração</span><small>Ex.: HubSpot comercial</small><input placeholder="Nome da integração" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} minLength={2} required /></label><label><span>Pasta de destino</span><small>Novos leads entram nesta fila</small><select aria-label="Pasta padrão" value={form.defaultFolderId} onChange={(event) => setForm({ ...form, defaultFolderId: event.target.value })} required><option value="">Selecione uma pasta</option>{activeFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><div className="integration-destination-note"><Icon name="archive" size={15} /><span><strong>O destino pode ser alterado depois.</strong><small>A pasta define em qual fila o contato ficará aguardando discagem.</small></span></div></div>}

        {step === 3 && <div className="integration-rules-form"><div className="integration-rule-card"><span className="integration-rule-icon"><Icon name="refresh" size={15} /></span><label><span>Leads duplicados</span><small>O que fazer quando o telefone já existe?</small><select aria-label="Duplicatas" value={form.duplicatePolicy} onChange={(event) => setForm({ ...form, duplicatePolicy: event.target.value })}><option value="update_existing">Atualizar o lead existente</option><option value="ignore_duplicate">Ignorar o novo lead</option><option value="reject_duplicate">Rejeitar o evento</option></select></label></div><div className="integration-rule-card"><span className="integration-rule-icon"><Icon name="chart" size={15} /></span><label><span>Prioridade padrão</span><small>Valores maiores entram primeiro na fila.</small><input type="number" aria-label="Prioridade padrão" min="-100" max="100" value={form.defaultPriority} onChange={(event) => setForm({ ...form, defaultPriority: event.target.value })} /></label></div><div className="integration-advanced-hint"><Icon name="unlock" size={13} /><span>A autenticação por API key e a assinatura HMAC já ficam ativas automaticamente.</span></div></div>}

        {step === 4 && !credentials && <div className="integration-review"><div className="integration-review-icon"><Icon name="check" size={19} /></div><div><strong>Tudo pronto para conectar</strong><p><b>{form.name || 'Sua integração'}</b> receberá leads na pasta <b>{activeFolders.find((folder) => folder.id === form.defaultFolderId)?.name || 'selecionada'}</b>, usando {typeOptions.find((option) => option.value === form.integrationType)?.title || 'Webhook'}.</p></div></div>}

        {step === 4 && credentials && <div className="integration-credentials" role="status"><div className="integration-credentials-head"><span className="integration-credentials-icon"><Icon name="check" size={16} /></span><div><strong>Credenciais prontas</strong><small>Copie e armazene agora. O segredo não será mostrado novamente.</small></div></div><label>URL do webhook<div className="credential-row"><input readOnly value={credentials.webhook_url} /><Button type="button" variant="secondary" icon="copy" onClick={() => void handleCopy('webhook', credentials.webhook_url)}>{copied === 'webhook' ? 'Copiado' : 'Copiar'}</Button></div></label><label>API key<div className="credential-row"><input readOnly value={credentials.api_key} /><Button type="button" variant="secondary" icon="copy" onClick={() => void handleCopy('key', credentials.api_key)}>{copied === 'key' ? 'Copiado' : 'Copiar'}</Button></div></label><label>Segredo HMAC<div className="credential-row"><input readOnly value={credentials.signing_secret} /><Button type="button" variant="secondary" icon="copy" onClick={() => void handleCopy('secret', credentials.signing_secret)}>{copied === 'secret' ? 'Copiado' : 'Copiar'}</Button></div></label><Button type="button" variant="secondary" onClick={resetSetup}>Criar outra integração</Button></div>}

        {!credentials && <div className="integration-form-footer"><span>{step > 1 && <Button type="button" variant="ghost" onClick={goBack}>Voltar</Button>}</span><Button type="submit" disabled={busy || (step === 2 && !activeFolders.length)} icon={step === 4 ? 'unlock' : 'chevron'}>{step === 4 ? (busy ? 'Gerando...' : 'Gerar credenciais') : 'Continuar'}</Button></div>}
      </form>
    </Panel>

    {showTutorial && <Panel className="integration-tutorial-panel"><div className="integration-tutorial-header"><div><span className="eyebrow">GUIA RÁPIDO</span><h2>Como funciona</h2><p>Uma integração tem três peças: origem, credencial e destino.</p></div><button className="integration-close-guide" type="button" onClick={() => setShowTutorial(false)} aria-label="Fechar guia">×</button></div><div className="integration-tutorial-compact"><div><span>1</span><strong>Gere a credencial</strong><small>Avance pelas etapas acima.</small></div><div><span>2</span><strong>Configure o provedor</strong><small>Use a URL e a API key geradas.</small></div><div><span>3</span><strong>Envie o lead</strong><small>Nome e telefone são obrigatórios.</small></div></div><details className="integration-code-details"><summary>Ver exemplo de envio por API</summary><div className="integration-tutorial-example"><div className="integration-tutorial-example-head"><span>Exemplo de envio</span><Badge tone="info">POST</Badge></div><pre>{curlExample}</pre><button className="integration-copy-example" type="button" onClick={() => void handleCopy('example', curlExample)}>{copied === 'example' ? 'Exemplo copiado' : 'Copiar exemplo'}</button></div></details><div className="integration-tutorial-note"><Icon name="alert" size={15} /><span><strong>Segurança:</strong> nunca compartilhe a API key em páginas públicas.</span></div></Panel>}

    <Panel className="integration-collapsible-panel"><button className="integration-collapsible-header" type="button" aria-expanded={showIntegrations} onClick={() => setShowIntegrations((current) => !current)}><span><span className="eyebrow">CONTROLE</span><strong>Integrações configuradas</strong><small>{integrations.length ? integrations.length + ' entradas para gerenciar' : 'Nenhuma entrada criada ainda'}</small></span><span className="integration-collapsible-action">{showIntegrations ? 'Ocultar' : 'Ver integrações'} <Icon name="chevron" size={14} /></span></button>{showIntegrations && <div className="integration-list integration-reveal-content">{integrations.map((integration) => <article className="integration-card" key={integration.id}><div className="integration-card-title"><span className="integration-card-icon"><Icon name="plug" size={15} /></span><div><strong>{integration.name}</strong><small>{integration.integration_type} · {folders.find((folder) => folder.id === integration.default_folder_id)?.name ?? 'Pasta removida'}</small></div></div><Badge tone={integration.status === 'active' ? 'success' : 'neutral'}>{integration.status === 'active' ? 'Ativa' : 'Revogada'}</Badge><div className="integration-stats"><span><small>Último recebimento</small><strong>{formatDate(integration.last_received_at)}</strong></span><span><small>Prioridade</small><strong>{integration.default_priority}</strong></span></div>{integration.status === 'active' && <div className="panel-actions"><Button variant="ghost" onClick={() => void rotate(integration.id)}>Rotacionar credenciais</Button><Button variant="danger" onClick={() => void revoke(integration.id)}>Revogar</Button></div>}</article>)}{!integrations.length && <EmptyState title="Nenhuma integração configurada" description="Crie uma entrada acima para começar a receber leads automaticamente." />}</div>}</Panel>

    <Panel className="integration-collapsible-panel integration-events-panel"><button className="integration-collapsible-header" type="button" aria-expanded={showEvents} onClick={() => setShowEvents((current) => !current)}><span><span className="eyebrow">OBSERVABILIDADE</span><strong>Atividade recente</strong><small>{lastEvent ? 'Último evento: ' + formatDate(lastEvent.received_at) : 'Os eventos recebidos aparecerão aqui'}</small></span><span className="integration-collapsible-action">{showEvents ? 'Ocultar' : 'Ver atividade'} <Icon name="chevron" size={14} /></span></button>{showEvents && <div className="integration-events integration-reveal-content">{events.map((item) => <div className="integration-event-row" key={item.id}><span className={'integration-event-dot integration-event-' + item.status} /><div><strong>{item.integration_name}</strong><small>{item.external_event_id || item.id}</small></div><Badge tone={['accepted', 'updated'].includes(item.status) ? 'success' : item.status === 'duplicate' ? 'neutral' : ['failed', 'dead_letter', 'rejected'].includes(item.status) ? 'warning' : 'info'}>{item.status}</Badge><time>{formatDate(item.received_at)}</time></div>)}{!events.length && <EmptyState title="Nenhum evento recebido" description="Quando seu CRM enviar o primeiro lead, o histórico aparecerá aqui." />}</div>}</Panel>
  </div>;
}
