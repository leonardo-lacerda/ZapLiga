import type React from 'react';
import { useEffect, useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, EmptyState, Panel, SectionHeader } from '../../components/ui';
import { createMetricsGoal, deleteMetricsGoal, fetchMetricsGoals, GoalInput, updateMetricsGoal } from './metrics.api';
import { GOAL_METRIC_OPTIONS, GOAL_METRIC_UNIT, GOAL_SCOPE_OPTIONS } from './metrics.definitions';
import { formatNumber, formatPercent, formatSecondsShort } from './metrics.format';
import type { GoalMetric, GoalScope, GoalValueType, MetricGoal } from './metrics.types';

function formatGoalValue(metric: GoalMetric, value: number) {
  const unit = GOAL_METRIC_UNIT[metric];
  if (unit === 'percent') return formatPercent(value);
  if (unit === 'seconds') return formatSecondsShort(value);
  return formatNumber(value);
}

const TREND_LABEL: Record<string, string> = { ahead: 'Adiantada', on_track: 'No ritmo', behind: 'Abaixo do ritmo', not_started: 'Ainda não começou' };
const TREND_TONE: Record<string, string> = { ahead: 'success', on_track: 'info', behind: 'warning', not_started: 'neutral' };

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
function emptyForm(): GoalInput {
  const today = new Date();
  return { scope: 'organization', metric: 'calls_made', valueType: 'absolute', targetValue: 0, periodFrom: isoDate(today), periodTo: isoDate(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
}

export function MetricsGoals({ leadFolders, sdrs }: { leadFolders: AnyRow[]; sdrs: AnyRow[] }) {
  const [goals, setGoals] = useState<MetricGoal[] | null>(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<GoalInput>(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = () => { fetchMetricsGoals({ status: 'active' }).then(setGoals).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); };
  useEffect(() => { load(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      if (editingId) await updateMetricsGoal(editingId, { valueType: form.valueType, targetValue: form.targetValue, periodFrom: form.periodFrom, periodTo: form.periodTo });
      else await createMetricsGoal(form);
      setShowForm(false); setEditingId(null); setForm(emptyForm());
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const startEdit = (goal: MetricGoal) => {
    setEditingId(goal.id);
    setForm({ scope: goal.scope, scopeId: goal.scopeId ?? undefined, metric: goal.metric, valueType: goal.valueType, targetValue: goal.targetValue, periodFrom: goal.periodFrom.slice(0, 10), periodTo: goal.periodTo.slice(0, 10) });
    setShowForm(true);
  };

  const remove = async (goal: MetricGoal) => {
    if (!window.confirm(`Excluir a meta de ${goal.metricLabel} para ${goal.scope === 'organization' ? 'a organização' : goal.scopeName}? O histórico permanece nos relatórios já gerados.`)) return;
    try { await deleteMetricsGoal(goal.id); load(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const scopeOptions: AnyRow[] = form.scope === 'sdr' ? sdrs : form.scope === 'folder' ? leadFolders : [];

  return <Panel>
    <SectionHeader eyebrow="METAS" title="Metas e progresso" description="Acompanhamento contra objetivos definidos pela liderança." action={<Button variant="secondary" onClick={() => { setShowForm(!showForm); setEditingId(null); setForm(emptyForm()); }}>{showForm ? 'Cancelar' : 'Nova meta'}</Button>} />
    {error && <div className="alert" role="alert"><span>{error}</span></div>}
    {showForm && <form className="metrics-goal-form" onSubmit={submit}>
      <label><span>Escopo</span>
        <select value={form.scope} disabled={!!editingId} onChange={(event) => setForm({ ...form, scope: event.target.value as GoalScope, scopeId: undefined })}>
          {GOAL_SCOPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {form.scope !== 'organization' && <label><span>{form.scope === 'sdr' ? 'SDR' : 'Pasta'}</span>
        <select value={form.scopeId ?? ''} disabled={!!editingId} required onChange={(event) => setForm({ ...form, scopeId: event.target.value })}>
          <option value="" disabled>Selecione</option>
          {scopeOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      <label><span>Métrica</span>
        <select value={form.metric} disabled={!!editingId} onChange={(event) => setForm({ ...form, metric: event.target.value as GoalMetric })}>
          {GOAL_METRIC_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label><span>Tipo de valor</span>
        <select value={form.valueType} onChange={(event) => setForm({ ...form, valueType: event.target.value as GoalValueType })}>
          <option value="absolute">Absoluto</option>
          <option value="percentage">Percentual</option>
        </select>
      </label>
      <label><span>Meta</span><input type="number" min={0} step="0.01" value={form.targetValue} onChange={(event) => setForm({ ...form, targetValue: Number(event.target.value) })} required /></label>
      <label><span>De</span><input type="date" value={form.periodFrom} onChange={(event) => setForm({ ...form, periodFrom: event.target.value })} required /></label>
      <label><span>Até</span><input type="date" value={form.periodTo} min={form.periodFrom} onChange={(event) => setForm({ ...form, periodTo: event.target.value })} required /></label>
      <Button disabled={saving}>{saving ? 'Salvando…' : editingId ? 'Salvar alteração' : 'Criar meta'}</Button>
    </form>}
    {!goals ? <div className="admin-loading" role="status" aria-label="Carregando metas"><span /><span /><span /></div> : !goals.length ? <EmptyState title="Nenhuma meta ativa" description="Crie uma meta para acompanhar o progresso da equipe." /> : <div className="metrics-goals-list">
      {goals.map((goal) => <div className="metrics-goal-card" key={goal.id}>
        <div className="metrics-goal-top">
          <div><strong>{goal.scope === 'organization' ? 'Organização' : goal.scopeName ?? '—'}</strong><span>{goal.metricLabel} · {goal.periodFrom} a {goal.periodTo}</span></div>
          <Badge tone={TREND_TONE[goal.progress.trend]}>{TREND_LABEL[goal.progress.trend]}</Badge>
        </div>
        <div className="metrics-goal-bar"><div className="metrics-goal-fill" style={{ width: `${Math.min(100, Math.max(2, goal.progress.progressPercent))}%` }} /></div>
        <div className="metrics-goal-numbers">
          <span>{formatGoalValue(goal.metric, goal.progress.actual)} de {formatGoalValue(goal.metric, goal.targetValue)} ({formatPercent(goal.progress.progressPercent)})</span>
          <span>Projeção: {formatGoalValue(goal.metric, goal.progress.projectedFinal)}{goal.progress.difference > 0 ? ` · faltam ${formatGoalValue(goal.metric, goal.progress.difference)}` : ' · meta batida na projeção'}</span>
        </div>
        <div className="metrics-goal-footer">
          <span>Criada por {goal.createdByName ?? '—'}</span>
          <div className="table-actions">
            <Button variant="ghost" onClick={() => startEdit(goal)}>Editar</Button>
            <Button variant="ghost" onClick={() => remove(goal)}>Excluir</Button>
          </div>
        </div>
      </div>)}
    </div>}
  </Panel>;
}
