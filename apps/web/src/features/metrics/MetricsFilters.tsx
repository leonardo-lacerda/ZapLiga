import { useEffect, useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Panel } from '../../components/ui';
import { DateRangePopover } from '../../components/DateRangePopover';
import { activeFilterCount, defaultMetricsFilters, MetricsFiltersState } from './useMetrics';
import { CALL_RESULT_OPTIONS, CALL_STATUS_OPTIONS, PIPELINE_STAGE_OPTIONS, SOURCE_OPTIONS } from './metrics.definitions';

function MultiSelect({ label, options, value, onChange }: { label: string; options: [string, string][]; value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((existing) => existing !== code) : [...value, code]);
  return <div className="metrics-filter-field">
    <span>{label}{value.length > 0 && <em className="metrics-filter-field-count">{value.length}</em>}</span>
    <div className="metrics-filter-options">
      {options.length === 0 && <span className="metrics-filter-empty">Nenhuma opção</span>}
      {options.map(([code, optionLabel]) => <label key={code} className={`metrics-filter-option${value.includes(code) ? ' selected' : ''}`}>
        <input type="checkbox" checked={value.includes(code)} onChange={() => toggle(code)} />
        <span>{optionLabel}</span>
      </label>)}
    </div>
  </div>;
}

export function MetricsFilters({ filters, onChange, leadFolders, sdrs, numbers }: { filters: MetricsFiltersState; onChange: (next: MetricsFiltersState) => void; leadFolders: AnyRow[]; sdrs: AnyRow[]; numbers: AnyRow[] }) {
  const [draftFilters, setDraftFilters] = useState(filters);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => { setDraftFilters(filters); }, [filters]);

  const set = <K extends keyof MetricsFiltersState>(key: K, value: MetricsFiltersState[K]) => setDraftFilters((current) => ({ ...current, [key]: value }));
  const count = activeFilterCount(filters);
  const draftCount = activeFilterCount(draftFilters);
  const hasPendingChanges = JSON.stringify(filters) !== JSON.stringify(draftFilters);
  const apply = () => onChange(draftFilters);
  const clear = () => {
    const next = { ...defaultMetricsFilters(), from: filters.from, to: filters.to };
    setDraftFilters(next);
    onChange(next);
  };

  return <Panel className="metrics-filters-panel">
    <div className="metrics-filters-top">
      <DateRangePopover value={{ from: draftFilters.from, to: draftFilters.to }} onChange={(range) => setDraftFilters((current) => ({ ...current, from: range.from, to: range.to }))} />
      <label className="metrics-filter-field metrics-filter-field-inline">
        <span>Origem</span>
        <select value={draftFilters.source} onChange={(event) => set('source', event.target.value as MetricsFiltersState['source'])}>
          {SOURCE_OPTIONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </label>
      <label className="metrics-compare-toggle">
        <input type="checkbox" checked={draftFilters.useCustomCompare} onChange={(event) => set('useCustomCompare', event.target.checked)} />
        Comparar com período personalizado
      </label>
      {draftFilters.useCustomCompare && <div className="metrics-compare-inputs">
        <label>De<input type="date" value={draftFilters.compareFrom} onChange={(event) => set('compareFrom', event.target.value)} /></label>
        <label>Até<input type="date" value={draftFilters.compareTo} onChange={(event) => set('compareTo', event.target.value)} /></label>
      </div>}
      <div className="metrics-filters-actions">
        {count > 0 && <Badge tone="info">{count} filtro{count > 1 ? 's' : ''} ativo{count > 1 ? 's' : ''}</Badge>}
        {hasPendingChanges && <Button variant="primary" onClick={apply}>Aplicar filtros{draftCount > 0 ? ` (${draftCount})` : ''}</Button>}
        <Button variant="ghost" onClick={clear}>Limpar filtros</Button>
      </div>
    </div>
    <button type="button" className="metrics-filter-disclosure" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((current) => !current)}>
      <span><strong>{showAdvanced ? 'Ocultar filtros avançados' : 'Mais filtros'}</strong><small>{showAdvanced ? 'Pastas, equipe, números e status' : 'Refine por equipe, pasta, número, resultado ou etapa'}</small></span>
      <span aria-hidden="true">{showAdvanced ? '−' : '+'}</span>
    </button>
    {showAdvanced && <div className="metrics-filters-grid">
      <MultiSelect label="Pastas" options={leadFolders.map((folder) => [folder.id, folder.name] as [string, string])} value={draftFilters.folderIds} onChange={(value) => set('folderIds', value)} />
      <MultiSelect label="SDRs" options={sdrs.map((sdr) => [sdr.id, sdr.name] as [string, string])} value={draftFilters.sdrIds} onChange={(value) => set('sdrIds', value)} />
      <MultiSelect label="Números" options={numbers.map((number) => [number.id, number.label] as [string, string])} value={draftFilters.numberIds} onChange={(value) => set('numberIds', value)} />
      <MultiSelect label="Resultado comercial" options={CALL_RESULT_OPTIONS} value={draftFilters.callResults} onChange={(value) => set('callResults', value)} />
      <MultiSelect label="Etapa do funil" options={PIPELINE_STAGE_OPTIONS} value={draftFilters.pipelineStages} onChange={(value) => set('pipelineStages', value)} />
      <MultiSelect label="Status técnico" options={CALL_STATUS_OPTIONS} value={draftFilters.statuses} onChange={(value) => set('statuses', value)} />
    </div>}
  </Panel>;
}
