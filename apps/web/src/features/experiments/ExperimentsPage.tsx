import { FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { EmptyGuide, FactGrid, FeatureOff, FlowSteps, HowItWorks, LoadingBlock, Notice, PageIntro, TechnicalDetails } from '../../components/guide';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

const metricLabels: Record<string, string> = { answer_rate: 'Taxa de atendimento', positive_rate: 'Resultado positivo', failure_rate: 'Taxa de falha', rapid_drop_rate: 'Chamadas que caem rápido' };
const metricHint: Record<string, string> = { answer_rate: 'quantas chamadas foram atendidas', positive_rate: 'quantas terminaram em resultado positivo', failure_rate: 'quantas falharam (quanto menor, melhor)', rapid_drop_rate: 'quantas caíram em até 5 segundos (quanto menor, melhor)' };
const guardrailCopy: Record<string, { label: string; hint: string }> = {
  failure_rate: { label: 'Chamadas falhando', hint: 'Se mais que isto falhar, o teste para sozinho.' },
  opt_out_rate: { label: 'Pedidos para não ligar', hint: 'Leads que pedem para sair durante o teste.' },
  rapid_drop_rate: { label: 'Chamadas caindo rápido', hint: 'Sinal de linha ou abordagem com problema.' },
  line_failure_rate: { label: 'Falha das linhas', hint: 'Protege os números de WhatsApp usados no teste.' },
};
const defaultGuardrails = [
  { metric: 'failure_rate', operator: 'max', threshold: .25 },
  { metric: 'opt_out_rate', operator: 'max', threshold: .1 },
  { metric: 'rapid_drop_rate', operator: 'max', threshold: .3 },
  { metric: 'line_failure_rate', operator: 'max', threshold: .35 },
];
const blankForm = () => ({ name: '', hypothesis: '', campaignId: '', primaryMetric: 'answer_rate', trafficPercent: 100, variants: [{ key: 'control', name: 'Como é hoje', allocationPercent: 50, cadenceMinutes: 60, priority: 50 }, { key: 'treatment', name: 'Nova forma', allocationPercent: 50, cadenceMinutes: 30, priority: 50 }], guardrails: defaultGuardrails.map((guardrail) => ({ ...guardrail })) });
const percent = (value: unknown) => value == null ? '—' : `${Math.round(Number(value) * 100)}%`;
const statusLabel: Record<string, string> = { draft: 'Rascunho', running: 'Rodando', paused: 'Pausado', stopped: 'Interrompido', completed: 'Concluído', archived: 'Arquivado' };
const statusTone = (status: string) => status === 'running' ? 'success' : status === 'stopped' ? 'error' : status === 'paused' ? 'warning' : 'info';
const statusMeaning: Record<string, string> = {
  draft: 'Ainda não começou. Revise a definição e clique em Iniciar.',
  running: 'Novos leads da campanha estão sendo divididos entre as variantes.',
  paused: 'Leads já divididos continuam na sua variante; nenhum lead novo entra.',
  stopped: 'Interrompido. Nenhum lead novo entra e o relatório fica guardado.',
  completed: 'Concluído. O relatório fica guardado para consulta.',
  archived: 'Arquivado.',
};
const lifecycle = [
  { key: 'draft', label: 'Rascunho', hint: 'Defina hipótese, variantes e limites' },
  { key: 'running', label: 'Rodando', hint: 'Leads novos são divididos' },
  { key: 'stopped', label: 'Encerrado', hint: 'Relatório guardado' },
];
const lifecycleKey = (status?: string) => status === 'paused' ? 'running' : status === 'completed' || status === 'archived' ? 'stopped' : status;
const guardrailAction: Record<string, { label: string; tone: string }> = { stopped: { label: 'Disparou e parou o teste', tone: 'error' }, observed: { label: 'Dentro do limite', tone: 'success' }, insufficient_data: { label: 'Poucos dados ainda', tone: 'neutral' } };
const dateTime = (value?: string) => value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export function ExperimentsPage({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const [experiments, setExperiments] = useState<AnyRow[]>([]);
  const [campaigns, setCampaigns] = useState<AnyRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [report, setReport] = useState<AnyRow | null>(null);
  const [form, setForm] = useState(blankForm);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!enabled || !tenantId) return;
    setLoading(true); setError('');
    try {
      const [experimentPage, campaignPage] = await Promise.all([json(`/api/tenants/${tenantId}/experiments`), json(`/api/tenants/${tenantId}/campaigns?status=running&limit=100`).catch(() => ({ items: [] }))]);
      const items: AnyRow[] = experimentPage.items ?? [];
      setExperiments(items); setCampaigns(campaignPage.items ?? []);
      const nextId = selectedId && items.some((item) => item.id === selectedId) ? selectedId : items[0]?.id ?? '';
      setSelectedId(nextId);
      setReport(nextId ? await json(`/api/tenants/${tenantId}/experiments/${nextId}/report`) : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [tenantId, enabled]);

  const open = (experiment: AnyRow) => { setSelectedId(experiment.id); setCreating(false); void json(`/api/tenants/${tenantId}/experiments/${experiment.id}/report`).then(setReport).catch((cause) => setError(String(cause))); };
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const created = await json(`/api/tenants/${tenantId}/experiments`, { method: 'POST', body: JSON.stringify(form) });
      setSelectedId(created.id); setCreating(false); setForm(blankForm()); setMessage('Experimento criado como rascunho. Revise e clique em Iniciar quando quiser começar.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const action = async (kind: 'start' | 'pause' | 'stop') => {
    if (!selectedId) return;
    if (kind === 'stop' && !window.confirm('Interromper o experimento? Nenhum lead novo entra e ele não pode ser retomado.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await json(`/api/tenants/${tenantId}/experiments/${selectedId}/${kind}`, { method: 'POST', body: kind === 'stop' ? JSON.stringify({ reason: 'Interrompido pelo operador' }) : undefined });
      setMessage(kind === 'start' ? 'Experimento rodando. Cada lead novo da campanha entra em uma variante e fica nela até o fim.' : kind === 'pause' ? 'Experimento pausado. Nenhum lead novo entra; os já divididos continuam.' : 'Experimento interrompido. O relatório fica guardado.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const updateVariant = (index: number, key: string, value: string | number) => setForm((current) => ({ ...current, variants: current.variants.map((variant, variantIndex) => variantIndex === index ? { ...variant, [key]: typeof value === 'number' ? value : value } : variant) }));
  const updateGuardrailPercent = (index: number, value: string) => setForm((current) => ({ ...current, guardrails: current.guardrails.map((guardrail, guardrailIndex) => guardrailIndex === index ? { ...guardrail, threshold: Math.min(1, Math.max(0, (Number(value) || 0) / 100)) } : guardrail) }));
  const allocationTotal = form.variants.reduce((sum, variant) => sum + Number(variant.allocationPercent || 0), 0);

  if (!enabled) return <FeatureOff title="Experimentos ainda não estão ligados para esta empresa" description="Com experimentos, você compara duas formas de trabalhar a mesma campanha (por exemplo, intervalo de retorno) e vê qual atende mais, com limites de segurança que param o teste sozinhos." />;
  if (loading && !experiments.length && !creating) return <LoadingBlock>Carregando experimentos…</LoadingBlock>;
  const selected = experiments.find((item) => item.id === selectedId);

  return <div className="guide-page experiments-page">
    <PageIntro
      eyebrow="OPERAÇÃO"
      title="Experimentos"
      purpose="Compare duas formas de trabalhar a mesma campanha e descubra qual atende mais. Cada lead entra em uma variante e fica nela até o fim, sem trocar a variante no meio do caminho. Limites de segurança param o teste sozinhos se algo piorar."
      aside={<Button icon="plus" onClick={() => { setCreating(true); setMessage(''); setError(''); }}>Novo experimento</Button>}
    />
    {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
    {message && <Notice tone="success" onClose={() => setMessage('')}>{message}</Notice>}

    {creating ? <Panel className="wizard-panel">
      <div className="wizard-heading"><div><span className="eyebrow">NOVO EXPERIMENTO</span><h2>O que você quer testar?</h2><p>Escreva a hipótese, escolha a campanha, defina as duas variantes e confirme os limites de segurança.</p></div><Button variant="ghost" onClick={() => setCreating(false)}>Cancelar</Button></div>
      <form className="form-stack" onSubmit={create}>
        <div className="form-grid-2">
          <label className="field"><span>Nome</span><input required minLength={2} maxLength={120} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ex.: Retorno em 30 min vs 60 min" /></label>
          <label className="field"><span>Campanha em andamento</span>
            {campaigns.length ? <select required value={form.campaignId} onChange={(event) => setForm((current) => ({ ...current, campaignId: event.target.value }))}><option value="">Escolha a campanha</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select> : <input required value={form.campaignId} onChange={(event) => setForm((current) => ({ ...current, campaignId: event.target.value }))} placeholder="Cole o ID da campanha" />}
            <small>{campaigns.length ? 'Só campanhas em andamento podem receber um experimento.' : 'Nenhuma campanha em andamento agora. Inicie uma em Campanhas, ou cole o ID de uma campanha.'}</small>
          </label>
          <label className="field span-all"><span>Hipótese</span><textarea required minLength={10} maxLength={2000} value={form.hypothesis} onChange={(event) => setForm((current) => ({ ...current, hypothesis: event.target.value }))} placeholder="Ex.: Retornar em 30 minutos em vez de 60 aumenta a taxa de atendimento sem aumentar pedidos para não ligar." /><small>O que você espera que melhore e o que não pode piorar.</small></label>
          <label className="field"><span>O que vamos medir</span><select value={form.primaryMetric} onChange={(event) => setForm((current) => ({ ...current, primaryMetric: event.target.value }))}>{Object.entries(metricLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>{metricHint[form.primaryMetric]}</small></label>
          <label className="field"><span>Parte da campanha no teste (%)</span><input type="number" min={1} max={100} value={form.trafficPercent} onChange={(event) => setForm((current) => ({ ...current, trafficPercent: Number(event.target.value) || 1 }))} /><small>100% = todos os leads novos entram no teste.</small></label>
        </div>

        <div className="form-section-head"><strong>As duas variantes</strong><small>A primeira é como você trabalha hoje; a segunda é a mudança que quer testar. As alocações precisam somar 100%.</small></div>
        <div className="form-grid-2">{form.variants.map((variant, index) => <div className="variant-card" key={variant.key}>
          <span className="eyebrow">{index === 0 ? 'CONTROLE' : 'VARIAÇÃO'}</span>
          <label className="field"><span>Nome</span><input aria-label={`Nome da variante ${index + 1}`} value={variant.name} onChange={(event) => updateVariant(index, 'name', event.target.value)} /></label>
          <div className="form-grid-3">
            <label className="field"><span>Leads (%)</span><input type="number" min={1} max={100} value={variant.allocationPercent} onChange={(event) => updateVariant(index, 'allocationPercent', Number(event.target.value) || 0)} /></label>
            <label className="field"><span>Intervalo de retorno (min)</span><input type="number" min={1} max={1440} value={variant.cadenceMinutes} onChange={(event) => updateVariant(index, 'cadenceMinutes', Number(event.target.value) || 0)} /></label>
            <label className="field"><span>Prioridade (0–100)</span><input type="number" min={0} max={100} value={variant.priority} onChange={(event) => updateVariant(index, 'priority', Number(event.target.value) || 0)} /></label>
          </div>
        </div>)}</div>
        {allocationTotal !== 100 && <Notice tone="warning">As alocações somam {allocationTotal}%. Ajuste para 100% antes de criar.</Notice>}

        <div className="form-section-head"><strong>Limites de segurança</strong><small>Se qualquer taxa passar do limite com amostra suficiente, o experimento para sozinho e você é avisado.</small></div>
        <div className="limit-list">{form.guardrails.map((guardrail, index) => <label className="limit-row" key={guardrail.metric}><div><strong>{guardrailCopy[guardrail.metric]?.label ?? guardrail.metric}</strong><small>{guardrailCopy[guardrail.metric]?.hint}</small></div><span className="limit-input"><span>até</span><input aria-label={`Limite de ${guardrailCopy[guardrail.metric]?.label ?? guardrail.metric}`} type="number" min={0} max={100} step={1} value={Math.round(guardrail.threshold * 100)} onChange={(event) => updateGuardrailPercent(index, event.target.value)} /><span>%</span></span></label>)}</div>

        <div className="wizard-footer"><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancelar</Button><Button type="submit" disabled={busy || allocationTotal !== 100} icon="check">{busy ? 'Criando…' : 'Criar rascunho'}</Button></div>
      </form>
    </Panel> : <div className="split-layout">
      <Panel className="split-list">
        <SectionHeader title="Seus experimentos" description="Clique em um para ver o andamento e o relatório." action={<Badge tone="info">{experiments.length}</Badge>} />
        {experiments.length ? <div className="pick-list">{experiments.map((experiment) => <button type="button" className={'pick-item' + (experiment.id === selectedId ? ' is-selected' : '')} key={experiment.id} onClick={() => open(experiment)}><span className="pick-icon"><Icon name="flask" size={15} /></span><span className="pick-copy"><strong>{experiment.name}</strong><small>{metricLabels[experiment.primaryMetric] ?? experiment.primaryMetric} · {experiment.variantCount ?? 2} variantes</small></span><Badge tone={statusTone(experiment.status)}>{statusLabel[experiment.status] ?? experiment.status}</Badge></button>)}</div> : <EmptyGuide icon="flask" title="Nenhum experimento ainda" text="Comece com uma pergunta simples, como “retornar em 30 minutos atende mais que em 60?”. O ZapLiga divide os leads novos e mostra o resultado." action={{ label: 'Novo experimento', icon: 'plus', onClick: () => setCreating(true) }} />}
      </Panel>
      <div className="split-detail">
        {selected ? <>
          <Panel>
            <div className="detail-heading"><div><span className="eyebrow">EXPERIMENTO</span><h2>{selected.name}</h2><p>{selected.hypothesis}</p></div><Badge tone={statusTone(selected.status)}>{statusLabel[selected.status] ?? selected.status}</Badge></div>
            <FlowSteps steps={lifecycle} current={lifecycleKey(selected.status)} label="Ciclo do experimento" />
            <div className="status-explainer">
              <p>{statusMeaning[selected.status] ?? ''}{selected.status === 'stopped' && selected.stopReason ? ` Motivo: ${selected.stopReason}.` : ''}</p>
              <div className="action-row">
                {['draft', 'paused'].includes(selected.status) && <Button icon="play" onClick={() => void action('start')} disabled={busy}>{selected.status === 'paused' ? 'Retomar' : 'Iniciar'}</Button>}
                {selected.status === 'running' && <Button variant="secondary" icon="pause" onClick={() => void action('pause')} disabled={busy}>Pausar</Button>}
                {['running', 'paused'].includes(selected.status) && <Button variant="danger" onClick={() => void action('stop')} disabled={busy}>Interromper</Button>}
              </div>
            </div>
            <FactGrid columns={3} facts={[
              { label: 'Medindo', value: metricLabels[selected.primaryMetric] ?? selected.primaryMetric, hint: metricHint[selected.primaryMetric] ?? '' },
              { label: 'Leads no teste', value: `${selected.trafficPercent ?? 100}%`, hint: 'dos leads novos da campanha' },
              { label: 'Começou em', value: selected.startedAt ? dateTime(selected.startedAt) : 'Ainda não', hint: selected.stoppedAt ? `encerrado ${dateTime(selected.stoppedAt)}` : '' },
            ]} />
          </Panel>
          {report && <Panel>
            <SectionHeader title="Resultado até agora" description="Lado a lado, com a faixa de incerteza. Quanto menor a amostra, maior a faixa." />
            <div className="two-column">{report.variants?.map((variant: AnyRow, index: number) => <article className="result-card" key={variant.id}>
              <div className="result-head"><strong>{variant.name}</strong><Badge tone={index === 0 ? 'info' : 'purple'}>{index === 0 ? 'Como é hoje' : 'Nova forma'}</Badge></div>
              <span className="result-metric">{metricLabels[report.primaryMetric] ?? report.primaryMetric}</span>
              <strong className="result-value">{percent(variant.primaryMetric?.value)}</strong>
              {variant.primaryMetric?.uncertainty && variant.primaryMetric?.value != null && <small>Provavelmente entre {percent(variant.primaryMetric.uncertainty.low)} e {percent(variant.primaryMetric.uncertainty.high)}</small>}
              <small>{variant.primaryMetric?.denominator ?? 0} chamadas · {variant.assignedCount ?? 0} leads nesta variante</small>
              {index > 0 && variant.observedDifferenceFromFirstVariant != null && <small className={Number(variant.observedDifferenceFromFirstVariant) >= 0 ? 'text-success' : 'text-warning'}>{Number(variant.observedDifferenceFromFirstVariant) >= 0 ? '+' : ''}{Math.round(Number(variant.observedDifferenceFromFirstVariant) * 100)} pontos em relação a “como é hoje”</small>}
            </article>)}</div>
            <p className="subtle result-note">Diferenças pequenas com faixas que se sobrepõem não indicam vencedor. Espere mais chamadas antes de decidir.</p>
            {report.guardrails?.evaluations?.length ? <div className="limit-list limit-list-report"><strong>Limites de segurança</strong>{report.guardrails.evaluations.map((evaluation: AnyRow) => <div className="limit-row" key={evaluation.metric}><div><strong>{guardrailCopy[evaluation.metric]?.label ?? evaluation.metric}</strong><small>observado {percent(evaluation.observedValue)} · limite {percent(evaluation.threshold)} · {evaluation.sampleSize ?? 0} na amostra</small></div><Badge tone={guardrailAction[evaluation.action]?.tone ?? 'neutral'}>{guardrailAction[evaluation.action]?.label ?? evaluation.action}</Badge></div>)}</div> : null}
            <TechnicalDetails><p className="subtle">{report.interpretation} Divisão dos leads: {report.attribution?.method ?? '—'} (estável). Amostra mínima por limite: {report.guardrails?.minimumSampleSize ?? '—'} chamadas.</p></TechnicalDetails>
          </Panel>}
        </> : <Panel><EmptyGuide icon="flask" title="Escolha um experimento ao lado" text="Você verá em que fase está, as duas variantes lado a lado e os limites de segurança." /></Panel>}
      </div>
    </div>}

    <Panel>
      <SectionHeader title="Como isto funciona" />
      <HowItWorks items={[
        { icon: 'users', title: 'Cada lead fica em uma variante', text: 'Ao entrar na campanha, o lead é sorteado para “como é hoje” ou “nova forma” e fica lá até o fim. Isso torna a comparação justa.' },
        { icon: 'lock', title: 'Limites que param o teste', text: 'Se chamadas falhando, pedidos para não ligar ou quedas rápidas passarem do limite, o experimento para sozinho.' },
        { icon: 'chart', title: 'Leia a faixa, não só o número', text: 'Cada resultado vem com uma faixa provável. Se as faixas das duas variantes se cruzam, ainda não há diferença confiável.' },
      ]} />
    </Panel>
  </div>;
}
