import { useCallback, useEffect, useState } from 'react';
import { Button, Panel, SectionHeader } from '../../components/ui';
import { fetchStats } from './provisioning.api';
import { errorExplanation, stepLabel } from './provisioning.labels';
import type { ProvisioningStats, StatsRate } from './provisioning.types';

const PERIODS = [7, 30, 90] as const;
const percent = (done: number, total: number) => (total ? `${Math.round((done / total) * 100)}%` : '—');
const seconds = (value: number) => (value >= 90 ? `${Math.round(value / 60)} min` : `${Math.round(value)} s`);

/**
 * Como estão os cadastros: quanto dá certo, onde e por que falha, por IP de saída e por versão
 * do WhatsApp, e quanto tempo cada etapa leva. Tudo vem do histórico dos cadastros terminados.
 */
export function StatsPanel({ tenantId }: { tenantId: string }) {
  const [days, setDays] = useState<number>(30);
  const [stats, setStats] = useState<ProvisioningStats | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setStats(await fetchStats(tenantId, days)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [tenantId, days]);

  useEffect(() => { void load(); }, [load]);

  return <Panel className="provisioning-stats">
    <SectionHeader
      title="Como estão os cadastros"
      description="Cadastros terminados no período: quanto dá certo, onde falha e quanto tempo cada etapa leva."
      action={<div className="provisioning-inline-actions">
        <label className="field"><span>Período</span>
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {PERIODS.map((value) => <option key={value} value={value}>Últimos {value} dias</option>)}
          </select>
        </label>
        <Button variant="ghost" icon="refresh" onClick={() => void load()}>Atualizar</Button>
      </div>}
    />
    {error && <p className="provisioning-field-error">{error}</p>}
    {!stats && !error && <p className="subtle">Carregando…</p>}
    {stats && !stats.total && <p className="subtle">Nenhum cadastro terminado nos últimos {stats.days} dias.</p>}
    {stats && stats.total > 0 && <>
      <dl className="provisioning-stats-summary">
        <div><dt>Cadastros</dt><dd>{stats.total}</dd></div>
        <div><dt>Deram certo</dt><dd>{stats.done} <small>({percent(stats.done, stats.total)})</small></dd></div>
        <div><dt>Falharam</dt><dd>{stats.failed}</dd></div>
        <div><dt>Cancelados</dt><dd>{stats.cancelled}</dd></div>
      </dl>
      <div className="provisioning-stats-grid">
        <StatsTable title="Por que falhou" head={['Motivo', 'Vezes']}
          rows={stats.failuresByError.map((row) => [errorExplanation(row.key).title, String(row.count)])} />
        <StatsTable title="Em que etapa falhou" head={['Etapa', 'Vezes']}
          rows={stats.failuresByStep.map((row) => [stepLabel(row.key), String(row.count)])} />
        <StatsTable title="Por IP de saída" head={['IP', 'Cadastros', 'Deram certo']} rows={rates(stats.byEgressIp)} />
        <StatsTable title="Por versão do WhatsApp" head={['App e versão', 'Cadastros', 'Deram certo']} rows={rates(stats.byAppVersion)} />
        <StatsTable title="Tempo por etapa" head={['Etapa', 'Mediana', 'Máximo']}
          rows={stats.stepDurations.map((row) => [stepLabel(row.key), seconds(row.median_s), seconds(row.max_s)])} />
      </div>
    </>}
  </Panel>;
}

const rates = (rows: StatsRate[]) => rows.map((row) => [row.key, String(row.total), percent(row.done, row.total)]);

function StatsTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return <section aria-label={title}>
    <h3>{title}</h3>
    {rows.length
      ? <div className="table-scroll"><table className="provisioning-stats-table">
        <thead><tr>{head.map((cell) => <th key={cell} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${row[0]}-${index}`}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
      </table></div>
      : <p className="subtle">Nada no período.</p>}
  </section>;
}
