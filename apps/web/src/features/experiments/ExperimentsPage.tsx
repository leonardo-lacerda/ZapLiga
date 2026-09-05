import { FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

const metricLabels: Record<string, string> = { answer_rate: 'Taxa de atendimento', positive_rate: 'Resultado positivo', failure_rate: 'Taxa de falha', rapid_drop_rate: 'Queda rápida' };
const guardrailLabels: Record<string, string> = { failure_rate: 'Falhas', opt_out_rate: 'Opt-out', rapid_drop_rate: 'Quedas rápidas', line_failure_rate: 'Saúde da linha' };
const defaultGuardrails = [
  { metric: 'failure_rate', operator: 'max', threshold: .25 },
  { metric: 'opt_out_rate', operator: 'max', threshold: .1 },
  { metric: 'rapid_drop_rate', operator: 'max', threshold: .3 },
  { metric: 'line_failure_rate', operator: 'max', threshold: .35 },
];
const blankForm = () => ({ name: '', hypothesis: '', campaignId: '', primaryMetric: 'answer_rate', trafficPercent: 100, variants: [{ key: 'control', name: 'Controle', allocationPercent: 50, cadenceMinutes: 60, priority: 50 }, { key: 'treatment', name: 'Variação', allocationPercent: 50, cadenceMinutes: 30, priority: 50 }], guardrails: defaultGuardrails.map((guardrail) => ({ ...guardrail })) });
const percent = (value: unknown) => value == null ? '—' : `${Math.round(Number(value) * 100)}%`;
const statusLabel: Record<string, string> = { draft: 'Rascunho', running: 'Rodando', paused: 'Pausado', stopped: 'Interrompido', completed: 'Concluído', archived: 'Arquivado' };
const statusTone = (status: string) => status === 'running' ? 'success' : ['stopped', 'archived'].includes(status) ? 'warning' : 'info';

export function ExperimentsPage({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const [experiments, setExperiments] = useState<AnyRow[]>([]);
  const [campaigns, setCampaigns] = useState<AnyRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [report, setReport] = useState<AnyRow | null>(null);
  const [form, setForm] = useState(blankForm);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!enabled || !tenantId) return;
    setLoading(true); setError('');
    try {
      const [experimentPage, campaignPage] = await Promise.all([
        json(`/api/tenants/${tenantId}/experiments`),
        json(`/api/tenants/${tenantId}/campaigns?status=running&limit=100`).catch(() => ({ items: [] })),
      ]);
      setExperiments(experimentPage.items ?? []); setCampaigns(campaignPage.items ?? []);
      const nextId = selectedId && (experimentPage.items ?? []).some((item: AnyRow) => item.id === selectedId) ? selectedId : experimentPage.items?.[0]?.id ?? '';
      setSelectedId(nextId);
      if (nextId) setReport(await json(`/api/tenants/${tenantId}/experiments/${nextId}/report`));
      else setReport(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [tenantId, enabled]);

  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const created = await json(`/api/tenants/${tenantId}/experiments`, { method: 'POST', body: JSON.stringify(form) });
      setSelectedId(created.id); setMessage('Experimento criado como rascunho. Revise a definição antes de iniciar.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const action = async (kind: 'start' | 'pause' | 'stop') => {
    if (!selectedId) return;
    setBusy(true); setError(''); setMessage('');
    try { await json(`/api/tenants/${tenantId}/experiments/${selectedId}/${kind}`, { method: 'POST', body: kind === 'stop' ? JSON.stringify({ reason: 'Interrompido pelo operador' }) : undefined }); setMessage(kind === 'start' ? 'Experimento iniciado com atribuição estável.' : kind === 'pause' ? 'Novas atribuições pausadas.' : 'Experimento interrompido.'); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const updateVariant = (index: number, key: string, value: string) => setForm((current) => ({ ...current, variants: current.variants.map((variant, variantIndex) => variantIndex === index ? { ...variant, [key]: Number(value) || 0 } : variant) }));
  const updateGuardrail = (index: number, value: string) => setForm((current) => ({ ...current, guardrails: current.guardrails.map((guardrail, guardrailIndex) => guardrailIndex === index ? { ...guardrail, threshold: Math.min(1, Math.max(0, Number(value) || 0)) } : guardrail) }));

  if (!enabled) return <Panel><div className="experiments-empty"><Icon name="lock" size={22} /><strong>Experimentação ainda não habilitada</strong><p>Ative esta capacidade por empresa quando a operação estiver pronta para comparar hipóteses.</p></div></Panel>;
  if (loading && !experiments.length) return <div className="experiments-page"><div className="experiments-loading">Lendo experimentos…</div></div>;
  const selected = experiments.find((item) => item.id === selectedId);
  return <div className="experiments-page">
    <div className="experiments-heading"><div><span className="eyebrow">EXPERIMENTAÇÃO CONTROLADA</span><h1>Testar melhorias com segurança</h1><p>Compare cadência e prioridade sem trocar a variante de um lead no meio do caminho.</p></div><Badge tone="info">Sem promessa causal</Badge></div>
    {(error || message) && <div className={`experiments-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || message}</div>}
    <div className="experiments-layout">
      <Panel><SectionHeader eyebrow="NOVO EXPERIMENTO" title="Defina a hipótese" description="O rascunho só poderá rodar com os quatro guardrails preenchidos." /><form className="experiments-form" onSubmit={create}><label>Nome<input required minLength={2} maxLength={120} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ex.: cadência de retorno" /></label><label>Campanha<select value={form.campaignId} onChange={(event) => setForm((current) => ({ ...current, campaignId: event.target.value }))}><option value="">Selecione uma campanha</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select><small>Se a campanha não aparecer, informe o ID na opção abaixo.</small></label><label>ID da campanha<input required value={form.campaignId} onChange={(event) => setForm((current) => ({ ...current, campaignId: event.target.value }))} placeholder="campaign_..." /></label><label>Hipótese<textarea required minLength={10} maxLength={2000} value={form.hypothesis} onChange={(event) => setForm((current) => ({ ...current, hypothesis: event.target.value }))} placeholder="O que esperamos observar e qual risco não pode piorar?" /></label><label>Métrica primária<select value={form.primaryMetric} onChange={(event) => setForm((current) => ({ ...current, primaryMetric: event.target.value }))}>{Object.entries(metricLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Tráfego da campanha (%)<input type="number" min={1} max={100} value={form.trafficPercent} onChange={(event) => setForm((current) => ({ ...current, trafficPercent: Number(event.target.value) || 1 }))} /></label><div className="experiments-subheading"><strong>Variantes</strong><small>Distribuição soma 100%; configuração limitada a cadência e prioridade.</small></div>{form.variants.map((variant, index) => <div className="experiment-variant-form" key={variant.key}><strong>{index === 0 ? 'Controle' : 'Variação'}</strong><input aria-label={`Nome da variante ${index + 1}`} value={variant.name} onChange={(event) => setForm((current) => ({ ...current, variants: current.variants.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) }))} /><label>Alocação %<input type="number" min={1} max={100} value={variant.allocationPercent} onChange={(event) => updateVariant(index, 'allocationPercent', event.target.value)} /></label><label>Cadência min<input type="number" min={1} max={1440} value={variant.cadenceMinutes} onChange={(event) => updateVariant(index, 'cadenceMinutes', event.target.value)} /></label><label>Prioridade<input type="number" min={0} max={100} value={variant.priority} onChange={(event) => updateVariant(index, 'priority', event.target.value)} /></label></div>)}<div className="experiments-subheading"><strong>Guardrails obrigatórios</strong><small>O experimento para quando uma taxa ultrapassa o limite com amostra mínima.</small></div>{form.guardrails.map((guardrail, index) => <label className="experiment-guardrail-row" key={guardrail.metric}><span>{guardrailLabels[guardrail.metric]}</span><input aria-label={`Limite de ${guardrailLabels[guardrail.metric]}`} type="number" min={0} max={1} step="0.01" value={guardrail.threshold} onChange={(event) => updateGuardrail(index, event.target.value)} /><small>máx.</small></label>)}<Button type="submit" disabled={busy}>{busy ? 'Criando…' : 'Criar rascunho'}</Button></form></Panel>
      <div className="experiments-side-column"><Panel><SectionHeader eyebrow="EXPERIMENTOS" title="Ciclo de vida" description="Atribuições e parada ficam registradas por empresa." />{experiments.length ? <div className="experiment-list">{experiments.map((experiment) => <button className={`experiment-list-item ${experiment.id === selectedId ? 'is-selected' : ''}`} key={experiment.id} onClick={() => { setSelectedId(experiment.id); void json(`/api/tenants/${tenantId}/experiments/${experiment.id}/report`).then(setReport).catch((cause) => setError(String(cause))); }}><span className="experiment-list-icon"><Icon name="flask" size={15} /></span><span><strong>{experiment.name}</strong><small>{metricLabels[experiment.primaryMetric] ?? experiment.primaryMetric} · {experiment.variantCount} variantes</small></span><Badge tone={statusTone(experiment.status)}>{statusLabel[experiment.status] ?? experiment.status}</Badge></button>)}</div> : <div className="experiments-empty-inline">Nenhum experimento criado ainda.</div>}</Panel>{selected && <Panel><div className="experiment-selected-heading"><div><span className="eyebrow">EXPERIMENTO SELECIONADO</span><h2>{selected.name}</h2><p>{selected.hypothesis}</p></div><Badge tone={statusTone(selected.status)}>{statusLabel[selected.status] ?? selected.status}</Badge></div><div className="experiment-actions">{['draft', 'paused'].includes(selected.status) && <Button onClick={() => void action('start')} disabled={busy}>Iniciar</Button>}{selected.status === 'running' && <Button variant="secondary" onClick={() => void action('pause')} disabled={busy}>Pausar atribuições</Button>}{['running', 'paused'].includes(selected.status) && <Button variant="danger" onClick={() => void action('stop')} disabled={busy}>Parar agora</Button>}</div>{report && <div className="experiment-report"><div className="experiment-report-note"><Icon name="info" size={15} /><span>{report.interpretation}</span></div><div className="experiment-report-grid">{report.variants?.map((variant: AnyRow) => <article key={variant.id}><div><strong>{variant.name}</strong><Badge tone={variant.key === report.variants[0]?.key ? 'info' : 'purple'}>{variant.key === report.variants[0]?.key ? 'Controle' : 'Variação'}</Badge></div><span>{metricLabels[report.primaryMetric] ?? report.primaryMetric}</span><strong className="experiment-report-value">{percent(variant.primaryMetric?.value)}</strong><small>{variant.primaryMetric?.denominator ?? 0} chamadas · {variant.assignedCount ?? 0} atribuídos</small>{variant.primaryMetric?.uncertainty && <small>IC 95%: {percent(variant.primaryMetric.uncertainty.low)}–{percent(variant.primaryMetric.uncertainty.high)}</small>}</article>)}</div></div>}</Panel>}</div>
    </div>
  </div>;
}
