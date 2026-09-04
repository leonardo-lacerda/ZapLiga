import { buildRecommendationCandidates } from './recommendations.catalog';

describe('buildRecommendationCandidates', () => {
  it('ranks critical items first, caps the center at three and keeps evidence structured', () => {
    const candidates = buildRecommendationCandidates([
      { id: 'info', code: 'folder_without_eligible_leads', severity: 'info', title: 'Fila vazia', evidence: 'pasta A', recommendedAction: 'ver leads' },
      { id: 'critical', code: 'queue_stalled', severity: 'critical', title: 'Fila parada', evidence: 'fila', recommendedAction: 'ver operação' },
      { id: 'warning', code: 'numbers_in_quarantine', severity: 'warning', title: 'Quarentena', evidence: 'linha', recommendedAction: 'ver linhas' },
      { id: 'extra', code: 'pending_wrap_ups', severity: 'info', title: 'Pós-atendimento', evidence: 'pendente', recommendedAction: 'ver chamadas' },
    ], '2026-09-04T12:00:00.000Z', 12);

    expect(candidates).toHaveLength(3);
    expect(candidates.map((item) => item.code)).toEqual(['queue_stalled', 'numbers_in_quarantine', 'folder_without_eligible_leads']);
    expect(candidates[0].evidence).toEqual({ summary: 'fila', source: 'metrics_summary', observedAt: '2026-09-04T12:00:00.000Z', sampleSize: 12 });
    expect(candidates[0].recommendedAction.type).toBe('navigate');
  });

  it('catalogs a reversible operational action with no client-controlled payload', () => {
    const [candidate] = buildRecommendationCandidates([
      { id: 'paused', code: 'dialer_paused_with_queue', severity: 'warning', title: 'Discador pausado', evidence: 'fila pronta', recommendedAction: 'iniciar' },
    ], '2026-09-04T12:00:00.000Z');

    expect(candidate.recommendedAction).toEqual({ label: 'Iniciar discador', description: 'Revalide agenda, SDRs e linhas e inicie o discador.', type: 'start_dialer', payload: {} });
  });
});
