import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

type CampaignsPageProps = { tenantId: string; folders: AnyRow[]; sdrs: AnyRow[]; numbers: AnyRow[]; featureEnabled?: boolean };
type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
type CampaignConfig = { queueStrategy: string; maxAttemptsPerLead: number; retryDelayMinutes: number; maxCallsPerMinute: number; minSecondsBetweenCalls: number; timezone: string; scheduleWindows: Array<{ dayOfWeek: number; startTime: string; endTime: string }> };

const emptyConfig = (): CampaignConfig => ({ queueStrategy: 'priority_fifo', maxAttemptsPerLead: 3, retryDelayMinutes: 60, maxCallsPerMinute: 20, minSecondsBetweenCalls: 10, timezone: 'America/Sao_Paulo', scheduleWindows: [] });
const statusLabel: Record<string, string> = { draft: 'Rascunho', ready: 'Pronta', running: 'Operando', paused: 'Pausada', completed: 'Concluída', archived: 'Arquivada' };
const statusTone: Record<string, string> = { draft: 'neutral', ready: 'info', running: 'success', paused: 'warning', completed: 'purple', archived: 'neutral' };
const steps = ['Objetivo', 'Pasta', 'Equipe', 'Regras', 'Meta', 'Revisão'];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatDate = (value?: string) => value ? new Date(value).toLocaleString('pt-BR') : '—';
const asIds = (items: AnyRow[]) => items.map((item) => String(item.id));
const initialForm = (folders: AnyRow[], sdrs: AnyRow[], numbers: AnyRow[]) => ({ name: '', description: '', folderId: folders.find((item) => item.is_active)?.id ?? folders[0]?.id ?? '', primaryGoalMetric: 'qualified_leads', primaryGoalTarget: '10', sdrIds: asIds(sdrs.filter((item) => item.is_active !== false).slice(0, 1)), numberIds: asIds(numbers.filter((item) => item.status !== 'removed').slice(0, 1)), config: emptyConfig() });

function campaignConfigFromRow(row: AnyRow): CampaignConfig { return { ...emptyConfig(), ...(row.draft_config ?? {}) }; }

export function CampaignsPage({ tenantId, folders, sdrs, numbers, featureEnabled = true }: CampaignsPageProps) {
  const [campaigns, setCampaigns] = useState<AnyRow[]>([]);
  const [selected, setSelected] = useState<AnyRow | null>(null);
  const [versions, setVersions] = useState<AnyRow[]>([]);
  const [diff, setDiff] = useState<AnyRow | null>(null);
  const [form, setForm] = useState(() => initialForm(folders, sdrs, numbers));
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !featureEnabled) return;
    try {
      const page = await json(`/api/tenants/${tenantId}/campaigns`);
      setCampaigns(page.items ?? []);
      if (selected?.id) {
        const [next, nextVersions] = await Promise.all([json(`/api/tenants/${tenantId}/campaigns/${selected.id}`), json(`/api/tenants/${tenantId}/campaigns/${selected.id}/versions`)]);
        setSelected(next); setVersions(nextVersions ?? []);
      }
    } catch (error) { setMessage(errorMessage(error)); }
  }, [tenantId, selected?.id, featureEnabled]);
  useEffect(() => { void load(); }, [load]);

  const select = async (campaign: AnyRow) => {
    setBusy(true); setMessage('');
    try { const [detail, nextVersions] = await Promise.all([json(`/api/tenants/${tenantId}/campaigns/${campaign.id}`), json(`/api/tenants/${tenantId}/campaigns/${campaign.id}/versions`)]); setSelected(detail); setVersions(nextVersions ?? []); setDiff(null); setEditing(false); setCreating(false); }
    catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };
  const startCreate = () => { setSelected(null); setCreating(true); setEditing(false); setWizardStep(1); setForm(initialForm(folders, sdrs, numbers)); setMessage(''); };
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
    if (wizardStep === 1 && form.name.trim().length < 2) return 'Informe um nome com ao menos 2 caracteres.';
    if (wizardStep === 2 && !form.folderId) return 'Selecione uma pasta principal.';
    if (wizardStep === 3 && creating && (!form.sdrIds.length || !form.numberIds.length)) return 'Selecione ao menos um SDR e uma linha.';
    return '';
  };
  const nextStep = () => { const issue = validateStep(); if (issue) { setMessage(issue); return; } setMessage(''); setWizardStep((current) => Math.min(6, current + 1) as WizardStep); };
  const previousStep = () => { setMessage(''); setWizardStep((current) => Math.max(1, current - 1) as WizardStep); };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (wizardStep < 6) { nextStep(); return; }
    const issue = validateStep(); if (issue) { setMessage(issue); return; }
    setBusy(true); setMessage('');
    const body = { ...form, name: form.name.trim(), description: form.description.trim() || undefined, primaryGoalTarget: form.primaryGoalTarget === '' ? undefined : Number(form.primaryGoalTarget), config: form.config };
    try {
      const result = creating ? await json(`/api/tenants/${tenantId}/campaigns`, { method: 'POST', body: JSON.stringify(body) }) : await json(`/api/tenants/${tenantId}/campaigns/${selected?.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, expectedLockVersion: Number(selected?.lock_version) }) });
      setCreating(false); setEditing(false); setSelected(result); setMessage(creating ? 'Campanha criada como rascunho.' : 'Alterações salvas.'); await load();
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };
  const transition = async (action: string, reason?: string) => {
    if (!selected) return;
    setBusy(true); setMessage('');
    try { const next = await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/${action}`, { method: 'POST', body: JSON.stringify({ expectedLockVersion: Number(selected.lock_version), reason }) }); setSelected(next); setMessage(action === 'publish' ? 'Versão publicada.' : `Campanha ${statusLabel[next.status]?.toLowerCase() ?? 'atualizada'}.`); await load(); }
    catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };
  const duplicate = async () => {
    if (!selected) return;
    const name = window.prompt('Nome da nova campanha:', `${selected.name} (cópia)`); if (name === null) return;
    setBusy(true); setMessage('');
    try { const next = await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/duplicate`, { method: 'POST', body: JSON.stringify({ name }) }); setSelected(next); setCreating(false); setEditing(false); setMessage('Cópia criada como rascunho.'); await load(); }
    catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };
  const loadDiff = async () => { if (versions.length < 2 || !selected) return; try { setDiff(await json(`/api/tenants/${tenantId}/campaigns/${selected.id}/diff?from=${versions[1].version}&to=${versions[0].version}`)); } catch (error) { setMessage(errorMessage(error)); } };
  const summary = useMemo(() => ({ running: campaigns.filter((item) => item.status === 'running').length, drafts: campaigns.filter((item) => item.status === 'draft').length, leads: campaigns.reduce((total, item) => total + Number(item.lead_count ?? 0), 0) }), [campaigns]);
  const selectedConfig = selected ? campaignConfigFromRow(selected) : null;

  if (!featureEnabled) return <div className="campaigns-page"><Panel><EmptyState title="Campanhas ainda não estão habilitadas" description="Peça a um super admin para habilitar este módulo em Admin → Detalhes da empresa → Recursos." /></Panel></div>;

  return <div className="campaigns-page">
    <div className="campaigns-heading"><div><span className="eyebrow">ORQUESTRAÇÃO</span><h1>Campanhas</h1><p>Transforme objetivo, equipe e regras em uma operação reproduzível.</p></div><Button icon="plus" onClick={startCreate}>Nova campanha</Button></div>
    {message && <div className="alert" role="status"><Icon name="alert" size={15} /><span>{message}</span><button type="button" aria-label="Fechar mensagem" onClick={() => setMessage('')}><Icon name="close" size={14} /></button></div>}
    <div className="campaign-summary-grid"><div><span>Campanhas</span><strong>{campaigns.length}</strong><small>no tenant atual</small></div><div><span>Em operação</span><strong>{summary.running}</strong><small>com versão imutável</small></div><div><span>Rascunhos</span><strong>{summary.drafts}</strong><small>aguardando publicação</small></div><div><span>Leads no escopo</span><strong>{summary.leads}</strong><small>somados nas filas</small></div></div>
    {creating || editing ? <Panel className="campaign-wizard-panel">
      <div className="campaign-wizard-heading"><div><span className="eyebrow">{creating ? 'NOVA CAMPANHA' : 'EDITAR CAMPANHA'}</span><h2>{steps[wizardStep - 1]}</h2><p>Monte a operação em etapas e revise antes de salvar.</p></div><span className="campaign-wizard-count">Etapa {wizardStep} de 6</span></div>
      <div className="campaign-stepper" aria-label="Progresso da campanha">{steps.map((label, index) => <button key={label} type="button" className={index + 1 <= wizardStep ? 'is-active' : ''} onClick={() => index + 1 < wizardStep && setWizardStep((index + 1) as WizardStep)}><span>{index + 1}</span><small>{label}</small></button>)}</div>
      <form onSubmit={(event) => void save(event)}>
        {wizardStep === 1 && <div className="campaign-form-grid"><label><span>Nome da campanha</span><small>Use um nome que a equipe reconheça em segundos.</small><input autoFocus value={form.name} onChange={(event) => updateForm({ name: event.target.value })} placeholder="Ex.: Reativação inbound Q4" /></label><label><span>Descrição</span><small>Contexto rápido para quem assumir a operação.</small><textarea value={form.description} onChange={(event) => updateForm({ description: event.target.value })} placeholder="Qual é a hipótese ou o público desta campanha?" /></label></div>}
        {wizardStep === 2 && <div className="campaign-choice-grid"><div><span className="campaign-field-title">Pasta principal</span><small>Os leads desta pasta formam o escopo inicial.</small>{folders.map((folder) => <button type="button" key={folder.id} className={'campaign-choice-card' + (form.folderId === folder.id ? ' is-selected' : '')} onClick={() => updateForm({ folderId: folder.id })}><span className="campaign-choice-icon"><Icon name="archive" size={16} /></span><span><strong>{folder.name}</strong><small>{folder.lead_count ?? 0} leads · {folder.is_active ? 'ativa' : 'inativa'}</small></span><span className="campaign-choice-radio" /></button>)}{!folders.length && <EmptyState title="Crie uma pasta primeiro" description="A campanha precisa de um escopo de leads." />}</div><div className="campaign-side-note"><Icon name="sparkles" size={18} /><strong>Escopo explícito</strong><p>A pasta fica registrada na definição da campanha. Isso torna a operação auditável e evita misturar filas por acidente.</p></div></div>}
        {wizardStep === 3 && <div className="campaign-resource-columns"><div><span className="campaign-field-title">SDRs responsáveis</span><small>Escolha quem pode receber esta fila.</small>{sdrs.map((sdr) => <label className="campaign-check-row" key={sdr.id}><input type="checkbox" checked={form.sdrIds.includes(sdr.id)} onChange={() => toggleId('sdrIds', sdr.id)} /><span><strong>{sdr.name}</strong><small>{sdr.available ? 'Disponível agora' : sdr.state ?? 'Offline'}</small></span></label>)}{!sdrs.length && <EmptyState title="Nenhum SDR cadastrado" />}</div><div><span className="campaign-field-title">Linhas de saída</span><small>As linhas autorizadas para esta campanha.</small>{numbers.map((number) => <label className="campaign-check-row" key={number.id}><input type="checkbox" checked={form.numberIds.includes(number.id)} onChange={() => toggleId('numberIds', number.id)} /><span><strong>{number.label}</strong><small>{number.status ?? 'Status desconhecido'}</small></span></label>)}{!numbers.length && <EmptyState title="Nenhuma linha cadastrada" />}</div></div>}
        {wizardStep === 4 && <div className="campaign-rules-grid"><label><span>Estratégia de fila</span><select value={form.config.queueStrategy} onChange={(event) => updateConfig({ queueStrategy: event.target.value })}><option value="priority_fifo">Prioridade + FIFO</option><option value="fifo">FIFO</option><option value="lifo">LIFO</option></select></label><label><span>Máx. tentativas por lead</span><input type="number" min="1" max="20" value={form.config.maxAttemptsPerLead} onChange={(event) => updateConfig({ maxAttemptsPerLead: Number(event.target.value) })} /></label><label><span>Intervalo de retry (minutos)</span><input type="number" min="1" max="43200" value={form.config.retryDelayMinutes} onChange={(event) => updateConfig({ retryDelayMinutes: Number(event.target.value) })} /></label><label><span>Máx. chamadas por minuto</span><input type="number" min="1" max="60" value={form.config.maxCallsPerMinute} onChange={(event) => updateConfig({ maxCallsPerMinute: Number(event.target.value) })} /></label><label><span>Segundos entre chamadas</span><input type="number" min="0" max="3600" value={form.config.minSecondsBetweenCalls} onChange={(event) => updateConfig({ minSecondsBetweenCalls: Number(event.target.value) })} /></label><label><span>Fuso horário</span><input value={form.config.timezone} onChange={(event) => updateConfig({ timezone: event.target.value })} /></label><div className="campaign-safety-note"><Icon name="alert" size={15} /><span>Os limites globais e as travas de segurança continuam valendo mesmo quando a campanha pede um valor maior.</span></div></div>}
        {wizardStep === 5 && <div className="campaign-goal-grid"><label><span>Métrica principal</span><select value={form.primaryGoalMetric} onChange={(event) => updateForm({ primaryGoalMetric: event.target.value })}><option value="qualified_leads">Leads qualificados</option><option value="meetings_booked">Reuniões marcadas</option><option value="connected_calls">Conversas conectadas</option><option value="conversion_rate">Taxa de conversão</option></select></label><label><span>Meta da campanha</span><input type="number" min="0" value={form.primaryGoalTarget} onChange={(event) => updateForm({ primaryGoalTarget: event.target.value })} /></label><div className="campaign-goal-preview"><Icon name="chart" size={17} /><div><strong>Meta visível no acompanhamento</strong><p>O objetivo fica salvo junto da versão e poderá alimentar recomendações e benchmarks nos próximos lotes.</p></div></div></div>}
        {wizardStep === 6 && <div className="campaign-review-grid"><div className="campaign-review-card"><span>Identidade</span><strong>{form.name || 'Sem nome'}</strong><small>{form.description || 'Sem descrição'}</small></div><div className="campaign-review-card"><span>Escopo</span><strong>{folders.find((item) => item.id === form.folderId)?.name ?? 'Pasta não selecionada'}</strong><small>{form.sdrIds.length} SDR(s) · {form.numberIds.length} linha(s)</small></div><div className="campaign-review-card"><span>Operação</span><strong>{form.config.queueStrategy}</strong><small>{form.config.maxAttemptsPerLead} tentativas · {form.config.maxCallsPerMinute} chamadas/min</small></div><div className="campaign-review-card"><span>Meta</span><strong>{form.primaryGoalTarget || 'Sem alvo'}</strong><small>{form.primaryGoalMetric || 'Sem métrica'}</small></div></div>}
        <div className="campaign-wizard-footer"><Button type="button" variant="ghost" onClick={cancelEditor}>Cancelar</Button><span>{wizardStep > 1 && <Button type="button" variant="ghost" onClick={previousStep}>Voltar</Button>}{wizardStep < 6 ? <Button type="button" onClick={nextStep}>Continuar</Button> : <Button type="submit" disabled={busy} icon="check">{busy ? 'Salvando...' : creating ? 'Criar rascunho' : 'Salvar alterações'}</Button>}</span></div>
      </form>
    </Panel> : <div className="campaign-layout"><Panel className="campaign-list-panel"><SectionHeader eyebrow="PORTFÓLIO" title="Suas campanhas" description="Cada campanha tem uma definição e um histórico de versões." action={<Badge tone="info">{campaigns.length} total</Badge>} />{campaigns.length ? <div className="campaign-list">{campaigns.map((campaign) => <button type="button" key={campaign.id} className={'campaign-list-item' + (selected?.id === campaign.id ? ' is-selected' : '')} onClick={() => void select(campaign)}><span className="campaign-list-icon"><Icon name={campaign.is_legacy ? 'archive' : 'sparkles'} size={16} /></span><span className="campaign-list-copy"><strong>{campaign.name}</strong><small>{campaign.folder_name ?? 'Sem pasta'} · {campaign.lead_count ?? 0} leads</small></span><Badge tone={statusTone[campaign.status] ?? 'neutral'}>{statusLabel[campaign.status] ?? campaign.status}</Badge><small className="campaign-list-version">{campaign.current_version ? `v${campaign.current_version}` : 'sem versão'}</small></button>)}</div> : <EmptyState title="Nenhuma campanha criada" description="Comece criando um rascunho com objetivo, equipe e regras." />}</Panel><div className="campaign-detail-column">{selected ? <Panel className="campaign-detail-panel"><div className="campaign-detail-heading"><div><span className="eyebrow">{selected.is_legacy ? 'LEGADO' : `VERSÃO ${selected.current_version ?? '—'}`}</span><h2>{selected.name}</h2><p>{selected.description || 'Sem descrição cadastrada.'}</p></div><Badge tone={statusTone[selected.status] ?? 'neutral'}>{statusLabel[selected.status] ?? selected.status}</Badge></div><div className="campaign-detail-meta"><span><small>Pasta</small><strong>{selected.folder_name ?? '—'}</strong></span><span><small>Leads</small><strong>{selected.lead_count ?? 0}</strong></span><span><small>Equipe</small><strong>{selected.sdr_count ?? 0} SDRs</strong></span><span><small>Versão</small><strong>{selected.current_version ? `v${selected.current_version}` : 'Rascunho'}</strong></span></div>{selected.is_legacy && <div className="campaign-legacy-note"><Icon name="archive" size={15} /><span>Esta campanha veio do modelo legado e é somente leitura. Duplique para entrar no novo ciclo de versionamento.</span></div>}<div className="campaign-actions">{!selected.is_legacy && selected.status !== 'archived' && selected.status !== 'completed' && <Button variant="secondary" onClick={beginEdit}>Editar definição</Button>}{selected.status === 'draft' && !selected.is_legacy && <Button onClick={() => void transition('publish', 'Publicação pela operação')}>Publicar v{Number(selected.current_version ?? 0) + 1}</Button>}{['ready', 'paused'].includes(selected.status) && <Button icon="play" onClick={() => void transition('start')}>Iniciar</Button>}{selected.status === 'running' && <Button variant="danger" icon="pause" onClick={() => void transition('pause')}>Pausar</Button>}{['running', 'paused'].includes(selected.status) && <Button variant="success" onClick={() => void transition('complete')}>Concluir</Button>}{['draft', 'ready', 'paused', 'completed'].includes(selected.status) && !selected.is_legacy && <Button variant="ghost" icon="archive" onClick={() => void transition('archive')}>Arquivar</Button>}<Button variant="ghost" icon="copy" onClick={() => void duplicate()}>Duplicar</Button></div><div className="campaign-version-strip"><div><span>Hash da versão ativa</span><code>{selected.current_version_hash ?? 'A publicação criará o primeiro hash'}</code></div><small>Lock {selected.lock_version ?? 0} · Atualizada {formatDate(selected.updated_at)}</small></div>{selectedConfig && <details className="campaign-config-details"><summary>Ver regras efetivas salvas</summary><div className="campaign-config-grid"><span>Fila <strong>{selectedConfig.queueStrategy ?? 'global'}</strong></span><span>Tentativas <strong>{selectedConfig.maxAttemptsPerLead ?? 'global'}</strong></span><span>Retry <strong>{selectedConfig.retryDelayMinutes ?? 'global'} min</strong></span><span>Ritmo <strong>{selectedConfig.maxCallsPerMinute ?? 'global'}/min</strong></span></div></details>}</Panel> : <Panel className="campaign-detail-panel campaign-empty-detail"><EmptyState title="Selecione uma campanha" description="A definição, as travas e o histórico de versões aparecerão aqui." /></Panel>}{selected && <Panel className="campaign-versions-panel"><SectionHeader eyebrow="AUDITORIA" title="Histórico de versões" description="Snapshots imutáveis para explicar o que mudou e quando." action={versions.length > 1 && <Button variant="ghost" onClick={() => void loadDiff()}>Comparar últimas</Button>} />{versions.length ? <div className="campaign-version-list">{versions.map((version) => <div key={version.id} className="campaign-version-row"><span className="campaign-version-number">v{version.version}</span><div><strong>{version.change_reason || 'Publicação'}</strong><small>{formatDate(version.created_at)} · lock {version.published_from_lock_version}</small></div><code>{String(version.config_hash).slice(0, 16)}…</code></div>)}</div> : <EmptyState title="Ainda sem versões" description="Publique o rascunho para criar o primeiro snapshot." />}{diff && <div className="campaign-diff"><div className="campaign-diff-heading"><strong>Diferenças v{diff.from} → v{diff.to}</strong><button type="button" className="icon-button" onClick={() => setDiff(null)} aria-label="Fechar comparação"><Icon name="close" size={14} /></button></div>{diff.changes?.length ? diff.changes.map((change: AnyRow) => <div className="campaign-diff-row" key={change.path}><code>{change.path}</code><span>{JSON.stringify(change.before) ?? '—'}</span><Icon name="chevron" size={12} /><span>{JSON.stringify(change.after) ?? '—'}</span></div>) : <small>Nenhuma diferença encontrada.</small>}</div>}</Panel>}</div></div>}
  </div>;
}
