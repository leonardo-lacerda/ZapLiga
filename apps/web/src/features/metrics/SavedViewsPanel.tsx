import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Panel, SectionHeader } from '../../components/ui';
import { createMetricsView, deleteMetricsView, fetchMetricsViews } from './metrics.api';
import type { SavedView } from './metrics.types';
import type { MetricsFiltersState } from './useMetrics';

export function SavedViewsPanel({ currentFilters, onApply }: { currentFilters: MetricsFiltersState; onApply: (filters: MetricsFiltersState) => void }) {
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => { fetchMetricsViews().then(setViews).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true); setError('');
    try {
      await createMetricsView({ name: name.trim(), isShared: shared, filters: currentFilters as unknown as Record<string, unknown> });
      setName(''); setShared(false);
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const remove = async (view: SavedView) => {
    if (!window.confirm(`Excluir a visualização "${view.name}"?`)) return;
    try { await deleteMetricsView(view.id); load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <Panel>
    <SectionHeader eyebrow="VISUALIZAÇÕES" title="Visualizações salvas" description="Salve a combinação de filtros atual para reaplicar depois, ou compartilhe com o time." />
    {error && <div className="alert" role="alert"><span>{error}</span></div>}
    <div className="metrics-saved-view-form">
      <input placeholder="Nome da visualização" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      <label className="metrics-compare-toggle"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />Compartilhar com a equipe</label>
      <Button variant="secondary" onClick={() => void save()} disabled={!name.trim() || saving}>{saving ? 'Salvando…' : 'Salvar filtros atuais'}</Button>
    </div>
    {views && (!views.length ? <EmptyState title="Nenhuma visualização salva ainda" /> : <ul className="metrics-saved-view-list">
      {views.map((view) => <li key={view.id} className="metrics-saved-view-item">
        <div className="metrics-saved-view-info">
          <strong>{view.name}</strong>
          {view.isShared && <Badge tone="info">Compartilhada</Badge>}
          <small>por {view.ownerName ?? '—'}</small>
        </div>
        <div className="table-actions">
          <Button variant="ghost" onClick={() => onApply(view.filters as unknown as MetricsFiltersState)}>Aplicar</Button>
          <Button variant="ghost" onClick={() => void remove(view)}>Excluir</Button>
        </div>
      </li>)}
    </ul>)}
  </Panel>;
}
