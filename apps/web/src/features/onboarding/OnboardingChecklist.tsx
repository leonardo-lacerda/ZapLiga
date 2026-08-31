import { useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

const stepPaths: Record<string, string> = {
  number_connected: '/app/numeros',
  sdr_invited: '/app/sdrs',
  leads_imported: '/app/leads',
  test_call_completed: '/app/',
  settings_reviewed: '/app/configuracoes',
  operation_started: '/app/',
};

export function OnboardingChecklist() {
  const [state, setState] = useState<AnyRow | null>(null);
  useEffect(() => { void json('/api/onboarding').then(setState).catch(() => undefined); }, []);
  if (!state || state.completed === state.total) return null;

  const markAudio = async () => setState(await json('/api/onboarding/audio-tested', { method: 'POST' }));
  const openStep = (path: string) => {
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return <Panel className="onboarding-panel">
    <SectionHeader eyebrow="PRIMEIROS PASSOS" title="Prepare sua primeira operação" description="O progresso é atualizado a partir dos dados reais da empresa." action={<Badge tone="info">{state.completed}/{state.total}</Badge>} />
    <div className="onboarding-steps">
      {state.steps.map((step: AnyRow) => <div className={step.completed ? 'done' : ''} key={step.key}>
        <Icon name={step.completed ? 'check' : 'more'} size={14} />
        <span>{step.label}</span>
        {step.key === 'audio_tested' && !step.completed && <Button variant="ghost" onClick={() => void markAudio()}>Marcar após teste</Button>}
        {!step.completed && stepPaths[step.key] && <Button variant="ghost" onClick={() => openStep(stepPaths[step.key])}>{step.key === 'test_call_completed' ? 'Abrir painel de chamada' : 'Abrir'}</Button>}
      </div>)}
    </div>
  </Panel>;
}
