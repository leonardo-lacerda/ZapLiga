import { useEffect, useMemo, useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Panel } from '../../components/ui';
import { LiveTimer, formatDuration } from '../../components/LiveTimer';
import { callResultOptions as results, pipelineStageOptions as stages } from '../../shared/format';

const stageByResult: Record<string, string> = {
  interessado: 'qualificado',
  sem_interesse: 'perdido',
  retornar: 'contatado',
  reuniao_agendada: 'reuniao',
  numero_invalido: 'perdido',
};

const localDateTime = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

export function PostCallPanel({ pause, onFinish, submitting, canContinue = true }: { pause: AnyRow; onFinish: (input: AnyRow) => void | Promise<void>; submitting: boolean; canContinue?: boolean }) {
  const [callResult, setCallResult] = useState('');
  const [pipelineStage, setPipelineStage] = useState('contatado');
  const [notes, setNotes] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  const callDuration = Number(pause.call_duration_seconds) || 0;
  const notesRequired = Boolean(callResult && !['sem_interesse', 'numero_invalido'].includes(callResult));
  const callbackRequired = callResult === 'retornar';
  const stageLabel = useMemo(() => stages.find(([value]) => value === pipelineStage)?.[1] ?? pipelineStage, [pipelineStage]);
  const canSubmit = Boolean(callResult && pipelineStage && (!notesRequired || notes.trim()) && (!callbackRequired || callbackAt));

  const chooseResult = (value: string) => {
    setCallResult(value);
    setPipelineStage(stageByResult[value] ?? 'contatado');
    if (value !== 'retornar') setCallbackAt('');
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < results.length) chooseResult(results[index][0]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const submit = (continueAvailable: boolean) => onFinish({
    callResult,
    pipelineStage,
    notes: notes.trim(),
    continueAvailable,
    callbackAt: callbackAt ? new Date(callbackAt).toISOString() : undefined,
  });

  return <Panel className="post-call-panel">
    <div className="post-call-heading"><div><span className="eyebrow">PÓS-ATENDIMENTO</span><h2>Como terminou a conversa?</h2><p>{pause.lead_name} · {pause.lead_phone}</p></div><div className="post-call-timers"><span><small>Ligação</small><strong>{formatDuration(callDuration)}</strong></span><span><small>Registro</small><strong><LiveTimer startedAt={pause.started_at} initialSeconds={pause.pause_elapsed_seconds} /></strong></span></div></div>
    <div className="post-call-form">
      <fieldset className="post-call-results"><legend>Resultado da ligação <small>atalhos 1–5</small></legend><div>{results.map(([value, label], index) => <button type="button" key={value} className={callResult === value ? 'selected' : ''} aria-pressed={callResult === value} onClick={() => chooseResult(value)}><kbd>{index + 1}</kbd>{label}</button>)}</div></fieldset>
      <div className="post-call-stage"><span>Etapa atualizada automaticamente</span><Badge tone={pipelineStage === 'perdido' ? 'error' : pipelineStage === 'reuniao' ? 'success' : 'info'}>{stageLabel}</Badge></div>
      {callbackRequired && <label className="post-call-callback">Data e horário do retorno<input type="datetime-local" min={localDateTime(new Date(Date.now() + 5 * 60_000))} value={callbackAt} onChange={(event) => setCallbackAt(event.target.value)} required /></label>}
      <label className="post-call-notes">Anotação {notesRequired ? <small>obrigatória</small> : <small>opcional</small>}<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={callbackRequired ? 'Registre o contexto para a próxima conversa...' : 'Resumo da conversa e próximo passo...'} rows={3} /></label>
    </div>
    <div className="post-call-footer"><span>{canContinue ? 'Escolha se deseja receber outra conversa agora ou fazer uma pausa.' : 'Conecte o canal para continuar disponível; você ainda pode salvar e pausar.'}</span><div className="post-call-actions"><Button variant="secondary" disabled={submitting || !canSubmit} onClick={() => void submit(false)}>{submitting ? 'Salvando...' : 'Salvar e pausar'}</Button><Button variant="success" icon="check" disabled={submitting || !canSubmit || !canContinue} onClick={() => void submit(true)}>{submitting ? 'Preparando áudio...' : canContinue ? 'Salvar e continuar' : 'Conecte para continuar'}</Button></div></div>
  </Panel>;
}
