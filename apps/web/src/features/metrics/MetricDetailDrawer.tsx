import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Icon } from '../../components/ui';
import { formatCallReason, labelStatus } from '../../shared/format';
import { ExportCsvButton } from './ExportCsvButton';
import { fetchMetricsCallsDrilldown, MetricsQueryParams } from './metrics.api';
import { CALL_RESULT_OPTIONS, labelFor, PIPELINE_STAGE_OPTIONS } from './metrics.definitions';
import { formatDateTime, formatNumber, formatSecondsShort } from './metrics.format';
import type { MetricsCallDrilldownItem, MetricsPage } from './metrics.types';

export type DrilldownTarget =
  | { kind: 'period'; label: string }
  | { kind: 'callResult'; code: string; label: string }
  | { kind: 'pipelineStage'; code: string; label: string }
  | { kind: 'sdr'; id: string; label: string }
  | { kind: 'folder'; id: string; label: string }
  | { kind: 'number'; id: string; label: string };

function targetToParams(target: DrilldownTarget): Partial<MetricsQueryParams> {
  if (target.kind === 'callResult') return { callResults: [target.code] };
  if (target.kind === 'pipelineStage') return { pipelineStages: [target.code] };
  if (target.kind === 'sdr') return { sdrIds: [target.id] };
  if (target.kind === 'folder') return { folderIds: [target.id] };
  if (target.kind === 'number') return { numberIds: [target.id] };
  return {};
}

const STATUS_TONE: Record<string, string> = { completed: 'success', failed: 'error', no_answer: 'warning', cancelled: 'warning', retry_wait: 'warning' };

export function MetricDetailDrawer({ target, baseParams, onClose, onApplyAsFilter }: { target: DrilldownTarget; baseParams: MetricsQueryParams; onClose: () => void; onApplyAsFilter: (target: DrilldownTarget) => void }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MetricsPage<MetricsCallDrilldownItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { setOffset(0); }, [target]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params: MetricsQueryParams = { ...baseParams, ...targetToParams(target), limit: '20', offset: String(offset) };
    fetchMetricsCallsDrilldown(params)
      .then((result) => { if (!cancelled) { setPage(result); setError(''); } })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, offset, JSON.stringify(baseParams)]);

  return <div className="admin-drawer-backdrop" onMouseDown={onClose}>
    <div className="admin-drawer metrics-drawer" role="dialog" aria-modal="true" aria-label={`Chamadas — ${target.label}`} onMouseDown={(event) => event.stopPropagation()}>
      <button className="admin-drawer-close" onClick={onClose} aria-label="Fechar"><Icon name="close" size={16} /></button>
      <span className="eyebrow">CHAMADAS RELACIONADAS</span>
      <h2>{target.label}</h2>
      <p>Mantendo os demais filtros ativos.{page ? ` ${formatNumber(page.total)} chamada(s) encontrada(s).` : ''}</p>
      <div className="metrics-drawer-actions">
        {target.kind !== 'period' && <Button variant="secondary" onClick={() => onApplyAsFilter(target)}>Aplicar como filtro</Button>}
        <ExportCsvButton dataset="calls" params={{ ...baseParams, ...targetToParams(target) }} label="Exportar CSV do conjunto filtrado" />
      </div>
      {loading && !page && <div className="admin-loading" role="status" aria-label="Carregando chamadas"><span /><span /><span /></div>}
      {error && <div className="alert" role="alert"><span>{error}</span></div>}
      {page && !page.items.length && <EmptyState title="Nenhuma chamada encontrada" description="Ajuste os filtros globais ou o período." />}
      <ul className="metrics-drawer-list">
        {page?.items.map((call) => <li className="metrics-drawer-item" key={call.callId}>
          <div className="metrics-drawer-item-top"><strong>{call.leadName || call.leadPhone}</strong><span>{formatDateTime(call.createdAt)}</span></div>
          <div className="metrics-drawer-item-meta">{call.folderName} · {call.sdrName} · {call.numberLabel} · tentativa {call.attemptNumber}</div>
          <div className="metrics-drawer-item-badges">
            <Badge tone={STATUS_TONE[call.status] ?? 'neutral'}>{labelStatus(call.status)}</Badge>
            {call.callResult && <Badge tone="info">{labelFor(CALL_RESULT_OPTIONS, call.callResult)}</Badge>}
            {call.pipelineStage && <Badge tone="purple">{labelFor(PIPELINE_STAGE_OPTIONS, call.pipelineStage)}</Badge>}
            <span className="metrics-drawer-duration">{formatSecondsShort(call.connectedDurationSeconds ?? 0)}</span>
          </div>
          {call.failureReason && <div className="metrics-drawer-item-note">Falha: {formatCallReason(call.failureReason)}</div>}
          {call.notes && <div className="metrics-drawer-item-note">Nota: {call.notes}</div>}
        </li>)}
      </ul>
      {page && page.total > page.limit && <div className="table-actions metrics-drawer-pagination">
        <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - page.limit))} disabled={offset === 0}>Anterior</Button>
        <span>{offset + 1}–{Math.min(offset + page.limit, page.total)} de {formatNumber(page.total)}</span>
        <Button variant="ghost" onClick={() => setOffset(offset + page.limit)} disabled={offset + page.limit >= page.total}>Próxima</Button>
      </div>}
    </div>
  </div>;
}
