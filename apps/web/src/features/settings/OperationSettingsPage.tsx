import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

const weekdays = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const timezones = ['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Belem', 'America/Rio_Branco'];
const settingFields = [
  ['global_max_concurrent_calls', 'Chamadas simultâneas', 1, 1000],
  ['max_calls_per_minute', 'Máximo de chamadas por minuto', 1, 60],
  ['min_seconds_between_calls', 'Espera entre ligações (s)', 0, 3600],
  ['max_attempts_per_lead', 'Tentativas por lead', 1, 100],
  ['retry_delay_minutes', 'Intervalo entre tentativas (min)', 0, 10080],
  ['ring_timeout_seconds', 'Tempo de toque (s)', 1, 600],
  ['default_number_cooldown_seconds', 'Proteção entre chamadas (s)', 0, 3600],
] as const;

export function OperationSettingsPage({ status, onChanged }: { status: AnyRow; onChanged: () => Promise<void> }) {
  const [schedule, setSchedule] = useState<AnyRow>({ timezone: 'America/Sao_Paulo', windows: [], exceptions: [] });
  const [settings, setSettings] = useState<AnyRow>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await json('/api/dialer/schedule');
      setSchedule({ ...next, windows: next.windows ?? [], exceptions: next.exceptions ?? [] });
      setSettings({ max_calls_per_minute: 6, min_seconds_between_calls: 10, ...(status.settings ?? {}) });
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [status.settings]);
  useEffect(() => { void load(); }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (status.running && !window.confirm('O discador está ativo. Confirmar a aplicação destas alterações agora? A fila será recalculada sem interromper chamadas em andamento.')) return;
    setBusy(true); setMessage('');
    try {
      const numericSettings = Object.fromEntries(settingFields.map(([key]) => [key, Number(settings[key])]));
      numericSettings.queue_strategy = settings.queue_strategy ?? 'fifo';
      await Promise.all([
        json('/api/dialer/settings', { method: 'PATCH', body: JSON.stringify(numericSettings) }),
        json('/api/dialer/schedule', { method: 'PUT', body: JSON.stringify(schedule) }),
      ]);
      setMessage('Configuração operacional salva. A nova janela já está valendo em todas as instâncias.');
      await onChanged(); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const updateWindow = (index: number, field: string, value: string | number) => setSchedule((current: AnyRow) => ({ ...current, windows: current.windows.map((item: AnyRow, itemIndex: number) => itemIndex === index ? { ...item, [field]: value } : item) }));
  const updateException = (index: number, field: string, value: string | boolean) => setSchedule((current: AnyRow) => ({ ...current, exceptions: current.exceptions.map((item: AnyRow, itemIndex: number) => itemIndex === index ? { ...item, [field]: value, ...(field === 'is_closed' && value ? { start_time: undefined, end_time: undefined } : {}) } : item) }));

  return <form onSubmit={save}>
    <Panel className="queue-strategy-panel"><SectionHeader title="Ordem da fila" description="Escolha como os leads elegíveis entram na próxima chamada." /><label className="operation-timezone"><span>Estratégia</span><select aria-label="Estratégia da fila" value={settings.queue_strategy ?? 'fifo'} onChange={(event) => setSettings((current) => ({ ...current, queue_strategy: event.target.value }))}><option value="fifo">FIFO · mais antigos primeiro</option><option value="lifo">LIFO · mais recentes primeiro</option><option value="priority_fifo">Prioridade + FIFO</option></select></label></Panel>
    <div className="page-heading"><div><span className="eyebrow">OPERAÇÃO</span><h1>Configurações do discador</h1><p>Defina limites, fuso e os únicos horários em que chamadas podem começar.</p></div><Badge tone={status.schedule?.allowed ? 'success' : 'warning'}>{status.schedule?.allowed ? 'Dentro do horário' : 'Fora do horário'}</Badge></div>
    {message && <div className="alert" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')}>×</button></div>}
    <Panel><SectionHeader title="Limites de discagem" description="Controles de concorrência, tentativas e proteção das linhas." /><div className="operation-settings-grid">{settingFields.map(([key, label, min, max]) => <label key={key}><span>{label}</span><input type="number" min={min} max={max} required value={settings[key] ?? ''} onChange={(event) => setSettings((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div></Panel>
    <Panel>
      <SectionHeader title="Janelas semanais" description="O fim da janela é exclusivo: uma janela até 18:00 não inicia chamadas às 18:00." action={<Button type="button" variant="secondary" icon="plus" onClick={() => setSchedule((current: AnyRow) => ({ ...current, windows: [...current.windows, { day_of_week: 1, start_time: '09:00', end_time: '18:00' }] }))}>Adicionar janela</Button>} />
      <label className="operation-timezone"><span>Fuso horário da operação</span><select value={schedule.timezone} onChange={(event) => setSchedule((current: AnyRow) => ({ ...current, timezone: event.target.value }))}>{timezones.map((timezone) => <option key={timezone}>{timezone}</option>)}</select></label>
      <div className="schedule-list">{schedule.windows.map((window: AnyRow, index: number) => <div className="schedule-row" key={index}><select aria-label="Dia da semana" value={window.day_of_week} onChange={(event) => updateWindow(index, 'day_of_week', Number(event.target.value))}>{weekdays.map((day, dayIndex) => <option value={dayIndex} key={day}>{day}</option>)}</select><input aria-label="Início" type="time" value={String(window.start_time).slice(0, 5)} onChange={(event) => updateWindow(index, 'start_time', event.target.value)} required /><span>até</span><input aria-label="Fim" type="time" value={String(window.end_time).slice(0, 5)} onChange={(event) => updateWindow(index, 'end_time', event.target.value)} required /><Button type="button" variant="ghost" onClick={() => setSchedule((current: AnyRow) => ({ ...current, windows: current.windows.filter((_: AnyRow, itemIndex: number) => itemIndex !== index) }))}>Remover</Button></div>)}{!schedule.windows.length && <EmptyState title="Operação fechada toda a semana" description="Adicione ao menos uma janela para permitir chamadas recorrentes." />}</div>
    </Panel>
    <Panel>
      <SectionHeader title="Exceções e feriados" description="Feche uma data específica ou informe um expediente especial." action={<Button type="button" variant="secondary" icon="plus" onClick={() => setSchedule((current: AnyRow) => ({ ...current, exceptions: [...current.exceptions, { local_date: '', is_closed: true, reason: '' }] }))}>Adicionar exceção</Button>} />
      <div className="schedule-list">{schedule.exceptions.map((exception: AnyRow, index: number) => <div className="schedule-row schedule-exception" key={index}><input aria-label="Data" type="date" required value={exception.local_date} onChange={(event) => updateException(index, 'local_date', event.target.value)} /><label className="schedule-closed"><input type="checkbox" checked={Boolean(exception.is_closed)} onChange={(event) => updateException(index, 'is_closed', event.target.checked)} />Fechado</label>{!exception.is_closed && <><input aria-label="Início especial" type="time" required value={exception.start_time ?? ''} onChange={(event) => updateException(index, 'start_time', event.target.value)} /><span>até</span><input aria-label="Fim especial" type="time" required value={exception.end_time ?? ''} onChange={(event) => updateException(index, 'end_time', event.target.value)} /></>}<input aria-label="Motivo" placeholder="Motivo opcional" maxLength={300} value={exception.reason ?? ''} onChange={(event) => updateException(index, 'reason', event.target.value)} /><Button type="button" variant="ghost" onClick={() => setSchedule((current: AnyRow) => ({ ...current, exceptions: current.exceptions.filter((_: AnyRow, itemIndex: number) => itemIndex !== index) }))}>Remover</Button></div>)}{!schedule.exceptions.length && <EmptyState title="Nenhuma exceção cadastrada" description="Feriados e expedientes especiais aparecerão aqui." />}</div>
    </Panel>
    <div className="operation-settings-save"><Button icon="check" disabled={busy}>{busy ? 'Salvando…' : 'Salvar configurações'}</Button></div>
  </form>;
}
