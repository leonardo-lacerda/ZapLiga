import { useState } from 'react';
import type { AnyRow } from '../../types';
import { Button, Panel } from '../../components/ui';
import { LiveTimer, formatDuration } from '../../components/LiveTimer';
import { callResultOptions as results, pipelineStageOptions as stages } from '../../shared/format';

export function PostCallPanel({ pause, onFinish, submitting }: { pause: AnyRow; onFinish: (input: AnyRow) => void; submitting: boolean }) {
  const [callResult, setCallResult] = useState('');
  const [pipelineStage, setPipelineStage] = useState('contatado');
  const [notes, setNotes] = useState('');
  const callDuration = Number(pause.call_duration_seconds) || 0;
  return <Panel className="post-call-panel">
    <div className="post-call-heading"><div><span className="eyebrow">PÓS-ATENDIMENTO</span><h2>Registre o que aconteceu</h2><p>{pause.lead_name} · {pause.lead_phone}</p></div><div className="post-call-timers"><span><small>Ligação</small><strong>{formatDuration(callDuration)}</strong></span><span><small>Pausa atual</small><strong><LiveTimer startedAt={pause.started_at} /></strong></span></div></div>
    <div className="post-call-form">
      <label>Resultado da ligação<select value={callResult} onChange={(event) => setCallResult(event.target.value)}><option value="">Selecione um resultado</option>{results.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Etapa da tubulação<select value={pipelineStage} onChange={(event) => setPipelineStage(event.target.value)}>{stages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="post-call-notes">Anotação<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Descreva o que foi conversado e o próximo passo..." rows={3} /></label>
    </div>
    <div className="post-call-footer"><span>O discador permanece parado para este SDR até salvar o registro.</span><Button icon="check" disabled={submitting || !callResult || !pipelineStage || !notes.trim()} onClick={() => onFinish({ callResult, pipelineStage, notes })}>{submitting ? 'Salvando...' : 'Salvar e ficar disponível'}</Button></div>
  </Panel>;
}
