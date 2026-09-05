import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { EmptyGuide, FactGrid, FeatureOff, FlowSteps, Notice, PageIntro, TechnicalDetails } from '../../components/guide';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

type CampaignsPageProps = { tenantId: string; folders: AnyRow[]; sdrs: AnyRow[]; numbers: AnyRow[]; featureEnabled?: boolean; decisionFeatureEnabled?: boolean };
type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
type CampaignConfig = { queueStrategy: string; maxAttemptsPerLead: number; retryDelayMinutes: number; maxCallsPerMinute: number; minSecondsBetweenCalls: number; timezone: string; scheduleWindows: Array<{ dayOfWeek: number; startTime: string; endTime: string }> };

const emptyConfig = (): CampaignConfig => ({ queueStrategy: 'priority_fifo', maxAttemptsPerLead: 3, retryDelayMinutes: 60, maxCallsPerMinute: 20, minSecondsBetweenCalls: 10, timezone: 'America/Sao_Paulo', scheduleWindows: [] });

// One vocabulary for the whole page: what each status is called, what it means
// for the leader, and what the natural next step is.
const statusLabel: Record<string, string> = { draft: 'Rascunho', ready: 'Publicada', running: 'Em andamento', paused: 'Pausada', completed: 'Concluída', archived: 'Arquivada' };
const statusTone: Record<string, string> = { draft: 'neutral', ready: 'info', running: 'success', paused: 'warning', completed: 'purple', archived: 'neutral' };
const statusMeaning: Record<string, string> = {
  draft: 'Ainda pode ser editada à vontade. Nada disca até você publicar e iniciar.',
  ready: 'A definição foi congelada em uma versão. Falta só iniciar para os leads entrarem na fila.',
  running: 'Os leads desta pasta estão sendo discados pela equipe e pelas linhas escolhidas.',
  paused: 'Nenhuma chamada nova sai desta campanha. Você pode retomar quando quiser.',
  completed: 'Encerrada. Os resultados ficam guardados e ela não volta a discar.',
  archived: 'Guardada fora da lista ativa. Duplique se quiser reaproveitar a definição.',
};
const lifecycle = [
  { key: 'draft', label: 'Rascunho', hint: 'Monte pasta, equipe, linhas e ritmo' },
  { key: 'ready', label: 'Publicada', hint: 'A definição vira uma versão fixa' },
  { key: 'running', label: 'Em andamento', hint: 'Os leads entram na fila' },
  { key: 'completed', label: 'Concluída', hint: 'Resultados guardados' },
];
const lifecycleKey = (status?: string) => status === 'paused' ? 'running' : status === 'archived' ? 'completed' : status;

const goalLabel: Record<string, string> = { qualified_leads: 'Leads qualificados', meetings_booked: 'Reuniões marcadas', connected_calls: 'Conversas conectadas', conversion_rate: 'Taxa de conversão' };
const queueLabel: Record<string, string> = { priority_fifo: 'Prioridade, depois quem chegou primeiro', fifo: 'Quem chegou primeiro', lifo: 'Quem chegou por último' };
const fieldLabel: Record<string, string> = { name: 'Nome', description: 'Descrição', folderId: 'Pasta', sdrIds: 'SDRs', numberIds: 'Linhas', primaryGoalMetric: 'Métrica da meta', primaryGoalTarget: 'Meta', queueStrategy: 'Ordem da fila', maxAttemptsPerLead: 'Tentativas por lead', retryDelayMinutes: 'Intervalo entre tentativas (min)', maxCallsPerMinute: 'Chamadas por minuto', minSecondsBetweenCalls: 'Segundos entre chamadas', timezone: 'Fuso horário', scheduleWindows: 'Janelas de horário' };
const reasonLabel: Record<string, string> = { score_priority: 'Prioridade do lead', lead_age: 'Tempo esperando na fila', recent_inbound: 'Contato recente do lead', callback_due: 'Retorno agendado vencido', previous_attempts: 'Tentativas anteriores', queue_fairness: 'Equilíbrio da fila', historical_signal: 'Histórico de atendimento' };
const blockLabel: Record<string, string> = { contact_suppressed: 'contato na lista de não-contato', folder_inactive: 'pasta inativa', active_call: 'já está em chamada', attempt_budget_exhausted: 'sem tentativas restantes', next_attempt_wait: 'aguardando o intervalo entre tentativas', callback_owned_by_another_sdr: 'retorno pertence a outro SDR', callback_due: 'tem retorno agendado', line_protected: 'linha protegida', line_cooldown: 'linha em pausa protetora', self_call: 'é o número da própria linha', lead_status_ineligible: 'status do lead não permite' };
const steps: Array<{ label: string; hint: string }> = [
  { label: 'Nome', hint: 'Como a equipe vai chamar esta campanha.' },
  { label: 'Leads', hint: 'De qual pasta saem os leads que serão discados.' },
  { label: 'Equipe e linhas', hint: 'Quem atende e por quais números de WhatsApp as chamadas saem.' },
  { label: 'Ritmo', hint: 'Quantas tentativas por lead e com que velocidade discar.' },
  { label: 'Meta', hint: 'O resultado que define sucesso para esta campanha.' },
  { label: 'Revisão', hint: 'Confira tudo antes de salvar o rascunho.' },
];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatDate = (value?: string) => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const asIds = (items: AnyRow[]) => items.map((item) => String(item.id));
const initialForm = (folders: AnyRow[], sdrs: AnyRow[], numbers: AnyRow[]) => ({ name: '', description: '', folderId: folders.find((item) => item.is_active)?.id ?? folders[0]?.id ?? '', primaryGoalMetric: 'qualified_leads', primaryGoalTarget: '10', sdrIds: asIds(sdrs.filter((item) => item.is_active !== false).slice(0, 1)), numberIds: asIds(numbers.filter((item) => item.status !== 'removed').slice(0, 1)), config: emptyConfig() });
const labelForPath = (path: string) => fieldLabel[path.split('.').pop() ?? path] ?? path;
const showValue = (value: unknown) => value == null ? '—' : Array.isArray(value) ? `${value.length} item(ns)` : typeof value === 'object' ? JSON.stringify(value) : String(value);

function campaignConfigFromRow(row: AnyRow): CampaignConfig { return { ...emptyConfig(), ...(row.draft_config ?? {}) }; }

export function CampaignsPage({ tenantId, folders, sdrs, numbers, featureEnabled = true, decisionFeatureEnabled = false }: CampaignsPageProps) {
  const [campaigns, setCampaigns] = useState<AnyRow[]>([]);
  const [selected, setSelected] = useState<AnyRow | null>(null);
  const [versions, setVersions] = useState<AnyRow[]>([]);
  const [diff, setDiff] = useState<AnyRow | null>(null);
  const [form, setForm] = useState(() => initialForm(folders, sdrs, numbers));
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info');
  const [busy, setBusy] = useState(false);
  const [playbooks, setPlaybooks] = useState<AnyRow[] | null>(null);
  const [showPlaybooks, setShowPlaybooks] = useState(false);
  const [decisionPolicy, setDecisionPolicy] = useState<AnyRow | null>(null);
  const [decisionComparison, setDecisionComparison] = useState<AnyRow | null>(null);
  const [decisionSimulation, setDecisionSimulation] = useState<AnyRow | null>(null);
  const [decisionMessage, setDecisionMessage] = useState('');
  const [decisionBusy, setDecisionBusy] = useState(false);

  const say = (text: string, tone: 'info' | 'success' | 'error' = 'info') => { setMessage(text); setMessageTone(tone); };
  const fail = (error: unknown) => say(errorMessage(error), 'error');

  const load = useCallback(async () => {
    if (!tenantId || !featureEnabled) return;
    try {
      const page = await json(`/api/tenants/${tenantId}/campaigns`);
      setCampaigns(page.items ?? []);
      if (selected?.id) {
        const [next, nextVersions] = await Promise.all([json(`/api/tenants/${tenantId}/campaigns/${selected.id}`), json(`/api/tenants/${tenantId}/campaigns/${selected.id}/versions`)]);
        setSelected(next); setVersions(nextVersions ?? []);
      }
    } catch (error) { fail(error); }
  }, [tenantId, selected?.id, featureEnabled]);
  useEffect(() => { void load(); }, [load]);

  const loadDecision = useCallback(async () => {
    if (!tenantId || !selected?.id || selected.is_legacy || !decisionFeatureEnabled) { setDecisionPolicy(null); setDecisionComparison(null); setDecisionSimulation(null); setDecisionMessage(''); return; }
    try {
      const [policy, comparison] = await Promise.all([json(`/api/tenants/${tenantId}/campaigns/${selected.id}/decision-policy`), json(`/api/tenants/${tenantId}/campaigns/${selected.id}/decision-comparison`)]);
      setDecisionPolicy(policy); setDecisionComparison(comparison); setDecisionMessage('');
    } catch (error) { setDecisionMessage(errorMessage(error)); }
  }, [tenantId, selected?.id, selected?.is_legacy, decisionFeatureEnabled]);
  useEffect(() => { void loadDecision(); }, [loadDecision]);

  const simulateDecision = async () => {
    if (!selected?.id) return;
    setDecisionBusy(true); setDecisionMessage('');
    try { setDecisionSimulation(await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/decision-policy/simulate`, { method: 'POST', body: JSON.stringify({ limit: 8 }) })); }
    catch (error) { setDecisionMessage(errorMessage(error)); } finally { setDecisionBusy(false); }
  };
  const changeDecisionMode = async (mode: string) => {
    if (!selected?.id || !['disabled', 'shadow', 'active'].includes(mode)) return;
    setDecisionBusy(true); setDecisionMessage('');
    try {
      const next = await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/decision-mode`, { method: 'POST', body: JSON.stringify({ mode }) });
      setDecisionPolicy((current) => ({ ...(current ?? {}), ...next }));
      setDecisionMessage(mode === 'active' ? 'Fila inteligente ativada para esta campanha.' : mode === 'shadow' ? 'A fila inteligente voltou a só observar, sem mudar a ordem.' : 'Fila inteligente desligada; a ordem configurada continua valendo.');
    } catch (error) { setDecisionMessage(errorMessage(error)); } finally { setDecisionBusy(false); }
  };

  const select = async (campaign: AnyRow) => {
    setBusy(true); setMessage('');
    try {
      const [detail, nextVersions] = await Promise.all([json(`/api/tenants/${tenantId}/campaigns/${campaign.id}`), json(`/api/tenants/${tenantId}/campaigns/${campaign.id}/versions`)]);
      setSelected(detail); setVersions(nextVersions ?? []); setDiff(null); setEditing(false); setCreating(false); setShowPlaybooks(false);
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const startCreate = () => { setSelected(null); setCreating(true); setEditing(false); setShowPlaybooks(false); setWizardStep(1); setForm(initialForm(folders, sdrs, numbers)); setMessage(''); };
  const cancelEditor = () => { setCreating(false); setEditing(false); setWizardStep(1); setMessage(''); };
  const beginEdit = () => {
    if (!selected || selected.is_legacy || ['completed', 'archived'].includes(selected.status)) return;
    setForm({ name: selected.name ?? '', description: selected.description ?? '', folderId: selected.folder_id ?? '', primaryGoalMetric: selected.primary_goal_metric ?? '', primaryGoalTarget: selected.primary_goal_target == null ? '' : String(selected.primary_goal_target), sdrIds: (selected.sdrs ?? []).map((item: AnyRow) => item.id), numberIds: (selected.numbers ?? []).map((item: AnyRow) => item.id), config: campaignConfigFromRow(selected) });
    setWizardStep(1); setEditing(true); setCreating(false); setMessage('');
  };
  const updateForm = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const updateConfig = (patch: Partial<CampaignConfig>) => setForm((current) => ({ ...current, config: { ...current.config, ...patch } }));
  const toggleId = (key: 'sdrIds' | 'numberIds', id: string) => setForm((current) => ({ ...current, [key]: current[key].includes(id) ? current[key].filter((value) => value !== id) : [...current[key], id] }));
  const validateStep = () => {
    if (wizardStep === 1 && form.name.trim().length < 2) return 'Dê um nome com pelo menos 2 caracteres.';
    if (wizardStep === 2 && !form.folderId) return 'Escolha a pasta de onde saem os leads.';
    if (wizardStep === 3 && creating && (!form.sdrIds.length || !form.numberIds.length)) return 'Escolha pelo menos um SDR e uma linha.';
    return '';
  };
  const nextStep = () => { const issue = validateStep(); if (issue) { say(issue, 'error'); return; } setMessage(''); setWizardStep((current) => Math.min(6, current + 1) as WizardStep); };
  const previousStep = () => { setMessage(''); setWizardStep((current) => Math.max(1, current - 1) as WizardStep); };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (wizardStep < 6) { nextStep(); return; }
    const issue = validateStep(); if (issue) { say(issue, 'error'); return; }
    setBusy(true); setMessage('');
    const body = { ...form, name: form.name.trim(), description: form.description.trim() || undefined, primaryGoalTarget: form.primaryGoalTarget === '' ? undefined : Number(form.primaryGoalTarget), config: form.config };
    try {
      const result = creating ? await json(`/api/tenants/${tenantId}/campaigns`, { method: 'POST', body: JSON.stringify(body) }) : await json(`/api/tenants/${tenantId}/campaigns/${selected?.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, expectedLockVersion: Number(selected?.lock_version) }) });
      setCreating(false); setEditing(false); setSelected(result); say(creating ? 'Campanha criada como rascunho.' : 'Alterações salvas.', 'success'); await load();
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const transition = async (action: string, reason?: string) => {
    if (!selected) return;
    setBusy(true); setMessage('');
    try {
      const next = await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/${action}`, { method: 'POST', body: JSON.stringify({ expectedLockVersion: Number(selected.lock_version), reason }) });
      setSelected(next);
      say(action === 'publish' ? `Versão ${next.current_version ?? ''} publicada. Agora é só iniciar.`.replace('  ', ' ') : action === 'start' ? 'Campanha em andamento. Os leads da pasta entraram na fila.' : action === 'pause' ? 'Campanha pausada. Nenhuma chamada nova sai dela.' : action === 'complete' ? 'Campanha concluída.' : 'Campanha arquivada.', 'success');
      await load();
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const duplicate = async () => {
    if (!selected) return;
    const name = window.prompt('Nome da nova campanha:', `${selected.name} (cópia)`); if (name === null) return;
    setBusy(true); setMessage('');
    try { const next = await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/duplicate`, { method: 'POST', body: JSON.stringify({ name }) }); setSelected(next); setCreating(false); setEditing(false); say('Cópia criada como rascunho.', 'success'); await load(); }
    catch (error) { fail(error); } finally { setBusy(false); }
  };
  const saveAsPlaybook = async () => {
    if (!selected || selected.is_legacy) return;
    const name = window.prompt('Nome do modelo:', `${selected.name} (modelo)`); if (name === null) return;
    setBusy(true); setMessage('');
    try { await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/playbook`, { method: 'POST', body: JSON.stringify({ name }) }); setPlaybooks(null); say('Modelo salvo. Ele aparece em "Começar de um modelo" para criar novas campanhas iguais a esta.', 'success'); }
    catch (error) { fail(error); } finally { setBusy(false); }
  };
  const openPlaybooks = async () => {
    setShowPlaybooks(true); setCreating(false); setEditing(false); setSelected(null); setMessage('');
    if (playbooks) return;
    try { setPlaybooks(await json(`/api/tenants/${tenantId}/campaign-playbooks`)); } catch (error) { fail(error); setPlaybooks([]); }
  };
  const usePlaybook = async (playbook: AnyRow) => {
    const name = window.prompt('Nome da nova campanha:', `${playbook.name}`); if (name === null) return;
    setBusy(true); setMessage('');
    try { const next = await json(`/api/tenants/${tenantId}/campaign-playbooks/${playbook.id}/instantiate`, { method: 'POST', body: JSON.stringify({ name }) }); setShowPlaybooks(false); setSelected(next); say('Campanha criada como rascunho a partir do modelo. Revise e publique quando quiser.', 'success'); await load(); }
    catch (error) { fail(error); } finally { setBusy(false); }
  };
  const loadDiff = async () => { if (versions.length < 2 || !selected) return; try { setDiff(await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/diff?from=${versions[1].version}&to=${versions[0].version}`)); } catch (error) { fail(error); } };

  const summary = useMemo(() => ({ running: campaigns.filter((item) => item.status === 'running').length, drafts: campaigns.filter((item) => item.status === 'draft').length, leads: campaigns.reduce((total, item) => total + Number(item.lead_count ?? 0), 0) }), [campaigns]);
  const selectedConfig = selected ? campaignConfigFromRow(selected) : null;

  if (!featureEnabled) return <FeatureOff title="Campanhas ainda não estão ligadas para esta empresa" description="Com campanhas, você agrupa uma pasta de leads, a equipe, as linhas e o ritmo de discagem em uma definição que pode ser publicada, pausada e comparada depois." />;

  type PrimaryAction = { label: string; icon: string; run: () => void; variant?: 'primary' | 'danger' };
  const primaryAction: PrimaryAction | null = selected && !selected.is_legacy
    ? selected.status === 'draft' ? { label: 'Publicar', icon: 'check', run: () => void transition('publish', 'Publicação pela operação') }
      : ['ready', 'paused'].includes(selected.status) ? { label: selected.status === 'paused' ? 'Retomar' : 'Iniciar', icon: 'play', run: () => void transition('start') }
        : selected.status === 'running' ? { label: 'Pausar', icon: 'pause', run: () => void transition('pause'), variant: 'danger' }
          : null
    : null;

  return <div className="guide-page campaigns-page">
    <PageIntro
      eyebrow="OPERAÇÃO"
      title="Campanhas"
      purpose="Uma campanha junta uma pasta de leads, a equipe que atende, as linhas que discam e o ritmo das chamadas. Publique para fixar essa combinação e inicie quando quiser."
      aside={<div className="action-row"><Button variant="secondary" icon="copy" onClick={() => void openPlaybooks()}>Começar de um modelo</Button><Button icon="plus" onClick={startCreate}>Nova campanha</Button></div>}
    />
    {message && <Notice tone={messageTone} onClose={() => setMessage('')}>{message}</Notice>}
    <FactGrid columns={3} facts={[
      { label: 'Em andamento', value: summary.running, hint: 'discando agora' },
      { label: 'Rascunhos', value: summary.drafts, hint: 'ainda não publicados' },
      { label: 'Leads no escopo', value: summary.leads, hint: 'somando todas as campanhas' },
    ]} />

    {creating || editing ? <Panel className="wizard-panel">
      <div className="wizard-heading">
        <div><span className="eyebrow">{creating ? 'NOVA CAMPANHA' : 'EDITAR CAMPANHA'}</span><h2>{steps[wizardStep - 1].label}</h2><p>{steps[wizardStep - 1].hint}</p></div>
        <span className="wizard-count">Etapa {wizardStep} de 6</span>
      </div>
      <ol className="wizard-steps" aria-label="Etapas da campanha">{steps.map((step, index) => <li key={step.label} className={index + 1 === wizardStep ? 'is-current' : index + 1 < wizardStep ? 'is-done' : ''}><button type="button" disabled={index + 1 >= wizardStep} onClick={() => setWizardStep((index + 1) as WizardStep)}><span>{index + 1 < wizardStep ? <Icon name="check" size={11} /> : index + 1}</span><small>{step.label}</small></button></li>)}</ol>
      <form onSubmit={(event) => void save(event)}>
        {wizardStep === 1 && <div className="form-grid-2">
          <label className="field"><span>Nome da campanha</span><input autoFocus value={form.name} onChange={(event) => updateForm({ name: event.target.value })} placeholder="Ex.: Reativação inbound Q4" /><small>Um nome que a equipe reconheça de imediato.</small></label>
          <label className="field"><span>Descrição <em>opcional</em></span><textarea value={form.description} onChange={(event) => updateForm({ description: event.target.value })} placeholder="Para quem é esta campanha e o que esperamos dela?" /><small>Contexto para quem assumir a operação depois.</small></label>
        </div>}
        {wizardStep === 2 && <div className="form-split">
          <div>
            <span className="field-title">Pasta de leads</span>
            <small className="field-help">Os leads desta pasta são os que serão discados. Você pode trocar a pasta enquanto a campanha for rascunho.</small>
            <div className="choice-list">{folders.map((folder) => <button type="button" key={folder.id} className={'choice-card' + (form.folderId === folder.id ? ' is-selected' : '')} onClick={() => updateForm({ folderId: folder.id })}><span className="pick-icon"><Icon name="archive" size={15} /></span><span className="pick-copy"><strong>{folder.name}</strong><small>{folder.lead_count ?? 0} leads · {folder.is_active ? 'ativa' : 'inativa'}</small></span><span className="choice-radio" /></button>)}{!folders.length && <EmptyGuide icon="archive" title="Crie uma pasta de leads primeiro" text="A campanha precisa saber de onde vêm os leads. Importe ou organize uma pasta em Leads." />}</div>
          </div>
          <aside className="side-note"><Icon name="info" size={16} /><div><strong>Por que a pasta fica fixa?</strong><p>A pasta faz parte da definição publicada. Assim dá para explicar depois exatamente quem foi discado por esta campanha, sem misturar filas por acidente.</p></div></aside>
        </div>}
        {wizardStep === 3 && <div className="form-grid-2">
          <div>
            <span className="field-title">Quem atende</span>
            <small className="field-help">Só estes SDRs recebem chamadas desta campanha.</small>
            <div className="choice-list">{sdrs.map((sdr) => <label className="check-card" key={sdr.id}><input type="checkbox" checked={form.sdrIds.includes(sdr.id)} onChange={() => toggleId('sdrIds', sdr.id)} /><span className="pick-copy"><strong>{sdr.name}</strong><small>{sdr.available ? 'Disponível agora' : sdr.state ?? 'Offline'}</small></span></label>)}{!sdrs.length && <EmptyGuide icon="users" title="Nenhum SDR cadastrado" text="Convide a equipe em SDRs antes de criar a campanha." />}</div>
          </div>
          <div>
            <span className="field-title">Por quais linhas</span>
            <small className="field-help">Os números de WhatsApp autorizados a discar por esta campanha.</small>
            <div className="choice-list">{numbers.map((number) => <label className="check-card" key={number.id}><input type="checkbox" checked={form.numberIds.includes(number.id)} onChange={() => toggleId('numberIds', number.id)} /><span className="pick-copy"><strong>{number.label}</strong><small>{number.status ?? 'status desconhecido'}</small></span></label>)}{!numbers.length && <EmptyGuide icon="phone" title="Nenhuma linha cadastrada" text="Conecte um número em Números antes de criar a campanha." />}</div>
          </div>
        </div>}
        {wizardStep === 4 && <div className="form-grid-3">
          <label className="field"><span>Ordem da fila</span><select value={form.config.queueStrategy} onChange={(event) => updateConfig({ queueStrategy: event.target.value })}>{Object.entries(queueLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>Como decidir qual lead é discado primeiro.</small></label>
          <label className="field"><span>Tentativas por lead</span><input type="number" min="1" max="20" value={form.config.maxAttemptsPerLead} onChange={(event) => updateConfig({ maxAttemptsPerLead: Number(event.target.value) })} /><small>Depois disso o lead sai da fila.</small></label>
          <label className="field"><span>Intervalo entre tentativas (min)</span><input type="number" min="1" max="43200" value={form.config.retryDelayMinutes} onChange={(event) => updateConfig({ retryDelayMinutes: Number(event.target.value) })} /><small>Tempo até tentar o mesmo lead de novo.</small></label>
          <label className="field"><span>Chamadas por minuto</span><input type="number" min="1" max="60" value={form.config.maxCallsPerMinute} onChange={(event) => updateConfig({ maxCallsPerMinute: Number(event.target.value) })} /><small>Teto de velocidade da campanha.</small></label>
          <label className="field"><span>Segundos entre chamadas</span><input type="number" min="0" max="3600" value={form.config.minSecondsBetweenCalls} onChange={(event) => updateConfig({ minSecondsBetweenCalls: Number(event.target.value) })} /><small>Pausa mínima entre duas chamadas.</small></label>
          <label className="field"><span>Fuso horário</span><input value={form.config.timezone} onChange={(event) => updateConfig({ timezone: event.target.value })} /><small>Usado para respeitar a agenda.</small></label>
          <div className="side-note span-all"><Icon name="lock" size={15} /><div><strong>Os limites gerais continuam valendo</strong><p>Se a campanha pedir um ritmo maior que o de Configurações do discador ou que a proteção das linhas permite, vale o menor.</p></div></div>
        </div>}
        {wizardStep === 5 && <div className="form-grid-2">
          <label className="field"><span>O que conta como resultado</span><select value={form.primaryGoalMetric} onChange={(event) => updateForm({ primaryGoalMetric: event.target.value })}>{Object.entries(goalLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field"><span>Meta</span><input type="number" min="0" value={form.primaryGoalTarget} onChange={(event) => updateForm({ primaryGoalTarget: event.target.value })} /><small>Um número para acompanhar. Pode ficar em branco.</small></label>
          <div className="side-note span-all"><Icon name="chart" size={15} /><div><strong>A meta fica salva com a versão</strong><p>Ela aparece no acompanhamento e ajuda a comparar campanhas depois. Não altera a discagem.</p></div></div>
        </div>}
        {wizardStep === 6 && <FactGrid columns={2} facts={[
          { label: 'Nome', value: form.name || 'Sem nome', hint: form.description || 'Sem descrição' },
          { label: 'Leads', value: folders.find((item) => item.id === form.folderId)?.name ?? 'Pasta não escolhida', hint: `${form.sdrIds.length} SDR(s) · ${form.numberIds.length} linha(s)` },
          { label: 'Ritmo', value: `${form.config.maxCallsPerMinute} chamadas/min`, hint: `${form.config.maxAttemptsPerLead} tentativas por lead · ${queueLabel[form.config.queueStrategy] ?? form.config.queueStrategy}` },
          { label: 'Meta', value: form.primaryGoalTarget ? `${form.primaryGoalTarget} ${goalLabel[form.primaryGoalMetric]?.toLowerCase() ?? ''}` : 'Sem meta numérica', hint: creating ? 'Será salva como rascunho; nada disca até publicar e iniciar.' : 'As alterações valem para a próxima publicação.' },
        ]} />}
        <div className="wizard-footer">
          <Button type="button" variant="ghost" onClick={cancelEditor}>Cancelar</Button>
          <span>{wizardStep > 1 && <Button type="button" variant="ghost" onClick={previousStep}>Voltar</Button>}{wizardStep < 6 ? <Button type="button" onClick={nextStep}>Continuar</Button> : <Button type="submit" disabled={busy} icon="check">{busy ? 'Salvando...' : creating ? 'Criar rascunho' : 'Salvar alterações'}</Button>}</span>
        </div>
      </form>
    </Panel> : <div className="split-layout">
      <Panel className="split-list">
        <SectionHeader title="Suas campanhas" description="Clique em uma para ver detalhes, publicar ou iniciar." action={<Badge tone="info">{campaigns.length}</Badge>} />
        {campaigns.length ? <div className="pick-list">{campaigns.map((campaign) => <button type="button" key={campaign.id} className={'pick-item' + (selected?.id === campaign.id ? ' is-selected' : '')} onClick={() => void select(campaign)}>
          <span className="pick-icon"><Icon name={campaign.is_legacy ? 'archive' : 'sparkles'} size={15} /></span>
          <span className="pick-copy"><strong>{campaign.name}</strong><small>{campaign.folder_name ?? 'Sem pasta'} · {campaign.lead_count ?? 0} leads{campaign.current_version ? ` · v${campaign.current_version}` : ''}</small></span>
          <Badge tone={statusTone[campaign.status] ?? 'neutral'}>{statusLabel[campaign.status] ?? campaign.status}</Badge>
        </button>)}</div> : <EmptyGuide icon="sparkles" title="Nenhuma campanha ainda" text="Crie a primeira: escolha uma pasta de leads, quem atende e o ritmo. Ela nasce como rascunho e só disca depois que você publicar e iniciar." action={{ label: 'Nova campanha', icon: 'plus', onClick: startCreate }} />}
      </Panel>

      <div className="split-detail">
        {showPlaybooks ? <Panel>
          <SectionHeader title="Começar de um modelo" description="Um modelo guarda a definição de uma campanha (pasta, equipe, linhas, ritmo e meta) para você criar outras iguais sem refazer tudo." action={<Button variant="ghost" onClick={() => setShowPlaybooks(false)}>Fechar</Button>} />
          {playbooks === null ? <div className="loading-block">Carregando modelos…</div> : playbooks.length ? <div className="pick-list">{playbooks.map((playbook) => <div className="pick-item is-static" key={playbook.id}><span className="pick-icon"><Icon name="copy" size={15} /></span><span className="pick-copy"><strong>{playbook.name}</strong><small>{playbook.description || (playbook.source_campaign_name ? `Salvo a partir de "${playbook.source_campaign_name}"` : 'Sem descrição')} · {formatDate(playbook.created_at)}</small></span><Button variant="secondary" disabled={busy} onClick={() => void usePlaybook(playbook)}>Usar modelo</Button></div>)}</div> : <EmptyGuide icon="copy" title="Nenhum modelo salvo" text="Abra uma campanha que já funcionou e use “Salvar como modelo”. Ela aparecerá aqui para criar novas campanhas iguais." />}
        </Panel> : selected ? <>
          <Panel>
            <div className="detail-heading">
              <div><span className="eyebrow">{selected.is_legacy ? 'CAMPANHA ANTIGA' : selected.current_version ? `VERSÃO ${selected.current_version}` : 'RASCUNHO'}</span><h2>{selected.name}</h2><p>{selected.description || 'Sem descrição.'}</p></div>
              <Badge tone={statusTone[selected.status] ?? 'neutral'}>{statusLabel[selected.status] ?? selected.status}</Badge>
            </div>
            {!selected.is_legacy && <FlowSteps steps={lifecycle} current={lifecycleKey(selected.status)} label="Ciclo da campanha" />}
            <div className="status-explainer">
              <p>{selected.is_legacy ? 'Esta campanha veio do modelo antigo e é somente leitura. Duplique para trazê-la para o ciclo atual.' : statusMeaning[selected.status] ?? ''}</p>
              {primaryAction && <Button variant={primaryAction.variant ?? 'primary'} icon={primaryAction.icon} disabled={busy} onClick={primaryAction.run}>{primaryAction.label}</Button>}
            </div>
            <FactGrid columns={4} facts={[
              { label: 'Pasta de leads', value: selected.folder_name ?? '—', hint: `${selected.lead_count ?? 0} leads` },
              { label: 'Equipe', value: `${selected.sdr_count ?? (selected.sdrs?.length ?? 0)} SDR(s)`, hint: `${selected.numbers?.length ?? 0} linha(s)` },
              { label: 'Ritmo', value: selectedConfig ? `${selectedConfig.maxCallsPerMinute}/min` : '—', hint: selectedConfig ? `${selectedConfig.maxAttemptsPerLead} tentativas por lead` : '' },
              { label: 'Meta', value: selected.primary_goal_target ?? '—', hint: goalLabel[selected.primary_goal_metric] ?? 'sem métrica' },
            ]} />
            <div className="action-row action-row-secondary">
              {!selected.is_legacy && !['completed', 'archived'].includes(selected.status) && <Button variant="secondary" onClick={beginEdit}>Editar</Button>}
              {['running', 'paused'].includes(selected.status) && <Button variant="secondary" icon="check" disabled={busy} onClick={() => void transition('complete')}>Concluir</Button>}
              <Button variant="ghost" icon="copy" disabled={busy} onClick={() => void duplicate()}>Duplicar</Button>
              {!selected.is_legacy && <Button variant="ghost" icon="note" disabled={busy} onClick={() => void saveAsPlaybook()}>Salvar como modelo</Button>}
              {['draft', 'ready', 'paused', 'completed'].includes(selected.status) && !selected.is_legacy && <Button variant="ghost" icon="archive" disabled={busy} onClick={() => void transition('archive')}>Arquivar</Button>}
            </div>
            <TechnicalDetails>
              <dl className="kv-list">
                <div><dt>Ordem da fila</dt><dd>{queueLabel[selectedConfig?.queueStrategy ?? ''] ?? selectedConfig?.queueStrategy ?? '—'}</dd></div>
                <div><dt>Intervalo entre tentativas</dt><dd>{selectedConfig?.retryDelayMinutes ?? '—'} min</dd></div>
                <div><dt>Segundos entre chamadas</dt><dd>{selectedConfig?.minSecondsBetweenCalls ?? '—'}</dd></div>
                <div><dt>Fuso horário</dt><dd>{selectedConfig?.timezone ?? '—'}</dd></div>
                <div><dt>Identificador da versão ativa</dt><dd><code>{selected.current_version_hash ?? 'criado na primeira publicação'}</code></dd></div>
                <div><dt>Última alteração</dt><dd>{formatDate(selected.updated_at)} · revisão {selected.lock_version ?? 0}</dd></div>
              </dl>
            </TechnicalDetails>

            {decisionFeatureEnabled && !selected.is_legacy && <section className="subsection">
              <div className="subsection-heading">
                <div><h3>Fila inteligente</h3><p>Reordena a fila desta campanha pelos leads com mais chance de atender, e explica o motivo de cada posição.</p></div>
                <div className="action-row">
                  <select aria-label="Modo da fila inteligente" className="inline-select" value={decisionPolicy?.mode ?? 'shadow'} onChange={(event) => void changeDecisionMode(event.target.value)} disabled={decisionBusy || !decisionPolicy}>
                    <option value="disabled">Desligada</option>
                    <option value="shadow">Só observando</option>
                    <option value="active">Ativa</option>
                  </select>
                  <Button variant="secondary" onClick={() => void simulateDecision()} disabled={decisionBusy}>{decisionBusy ? 'Simulando…' : 'Simular ordem'}</Button>
                </div>
              </div>
              <p className="subsection-help">{decisionPolicy?.mode === 'active' ? 'Ativa: a ordem sugerida está valendo nesta campanha.' : decisionPolicy?.mode === 'disabled' ? 'Desligada: vale só a ordem configurada na campanha.' : 'Só observando: calcula a ordem sugerida e registra a diferença, mas não muda a fila. É o modo seguro para começar.'}</p>
              <FactGrid columns={3} facts={[
                { label: 'Decisões registradas', value: decisionComparison?.summary?.count ?? 0, hint: 'comparações feitas' },
                { label: 'Diferença média de posição', value: decisionComparison?.summary?.average_position_delta ?? 0, hint: 'em relação à ordem configurada' },
                { label: 'Regra em uso', value: decisionPolicy ? `v${decisionPolicy.version}` : '—', hint: 'versão da política' },
              ]} />
              {decisionMessage && <Notice tone={decisionMessage.includes('ativada') || decisionMessage.includes('voltou') || decisionMessage.includes('desligada') ? 'success' : 'error'}>{decisionMessage}</Notice>}
              {decisionSimulation ? <div className="rank-list">{decisionSimulation.candidates?.length ? decisionSimulation.candidates.map((candidate: AnyRow) => <div className={'rank-row' + (candidate.eligibility?.eligible ? '' : ' is-blocked')} key={candidate.id}>
                <span className="rank-position">{candidate.eligibility?.eligible ? `#${candidate.suggested_position ?? '—'}` : '—'}</span>
                <div><strong>Lead {String(candidate.id).slice(0, 8)} · pontuação {candidate.score}</strong><small>{candidate.eligibility?.blockedBy?.length ? `Não será discado: ${candidate.eligibility.blockedBy.map((code: string) => blockLabel[code] ?? code.replaceAll('_', ' ')).join(', ')}` : (candidate.reasons ?? []).slice(0, 4).map((reason: AnyRow) => `${reasonLabel[reason.code] ?? reason.code} ${reason.effect > 0 ? '+' : ''}${reason.effect}`).join(' · ')}</small></div>
              </div>) : <EmptyGuide icon="users" title="Nenhum lead elegível agora" text="Quando a pasta tiver leads prontos para discar, a simulação mostra a ordem sugerida." />}</div> : <p className="subsection-help subtle">Clique em “Simular ordem” para ver quem seria discado primeiro e por quê.</p>}
            </section>}
          </Panel>

          <Panel>
            <SectionHeader title="Histórico de publicações" description="Cada publicação guarda uma cópia fixa da definição. Assim dá para saber o que mudou e quando." action={versions.length > 1 && <Button variant="ghost" onClick={() => void loadDiff()}>Comparar últimas</Button>} />
            {versions.length ? <div className="version-list">{versions.map((version) => <div key={version.id} className="version-row"><span className="version-number">v{version.version}</span><div><strong>{version.change_reason || 'Publicação'}</strong><small>{formatDate(version.created_at)}</small></div></div>)}</div> : <EmptyGuide icon="history" title="Ainda não foi publicada" text="Ao publicar o rascunho, a primeira versão aparece aqui." />}
            {diff && <div className="diff-block">
              <div className="diff-heading"><strong>O que mudou de v{diff.from} para v{diff.to}</strong><button type="button" className="notice-close" onClick={() => setDiff(null)} aria-label="Fechar comparação"><Icon name="close" size={13} /></button></div>
              {diff.changes?.length ? diff.changes.map((change: AnyRow) => <div className="diff-row" key={change.path}><div><strong>{labelForPath(String(change.path))}</strong><code>{change.path}</code></div><span>{showValue(change.before)}</span><Icon name="chevron" size={12} /><span>{showValue(change.after)}</span></div>) : <small>Nenhuma diferença entre as duas versões.</small>}
            </div>}
          </Panel>
        </> : <Panel><EmptyGuide icon="sparkles" title="Escolha uma campanha ao lado" text="Aqui você vê o que ela faz, em que etapa está e o que fazer em seguida." /></Panel>}
      </div>
    </div>}
  </div>;
}
