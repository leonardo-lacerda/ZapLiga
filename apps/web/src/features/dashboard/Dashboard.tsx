import type { AnyRow } from '../../types';
import type { AudioDeviceState, InboundAudioLevel } from '../../audio/AudioBridge';
import { describeDevice, isPseudoDevice } from '../../audio/audioDevices';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { LiveTimer } from '../../components/LiveTimer';
import { formatDurationCompact } from '../../shared/format';
import { PostCallPanel } from '../calls/PostCallPanel';
import { OrganizerOverview } from './OrganizerOverview';

type SdrPresence = 'offline' | 'connecting' | 'connected' | 'available' | 'dialing' | 'in-call' | 'post-call';

const presenceCopy: Record<SdrPresence, { label: string; description: string; tone: 'neutral' | 'info' | 'success' | 'warning' }> = {
  offline: { label: 'Desconectado', description: 'Conecte seu painel para começar a receber chamadas.', tone: 'neutral' },
  connecting: { label: 'Conectando', description: 'Estabelecendo o canal seguro com a operação…', tone: 'info' },
  connected: { label: 'Conectado · indisponível', description: 'Você pode fazer discagens manuais, mas ainda não receberá chamadas automáticas.', tone: 'neutral' },
  available: { label: 'Disponível', description: 'Aguardando uma chamada da fila.', tone: 'success' },
  dialing: { label: 'Chamando', description: 'A chamada está tocando para o lead.', tone: 'info' },
  'in-call': { label: 'Em atendimento', description: 'O lead atendeu. Fale com ele pelo seu headset.', tone: 'success' },
  'post-call': { label: 'Pós-atendimento', description: 'Registre o resultado da chamada para continuar.', tone: 'warning' },
};

function getSdrPresence({ connecting, connected, sdrReady, available, activeCall, postCall, manualCalling }: AnyRow): SdrPresence {
  if (postCall) return 'post-call';
  if (activeCall) return activeCall.phase === 'answered' || activeCall.mediaActive ? 'in-call' : 'dialing';
  if (manualCalling) return 'dialing';
  if (connecting || (connected && !sdrReady)) return 'connecting';
  if (available) return 'available';
  if (connected && sdrReady) return 'connected';
  return 'offline';
}

export function Dashboard(props: AnyRow) {
  const { isSdr, status, available, connected, connecting, sdrReady, sdrs, connectSdr, setAvailability, manualDial, manualPhone, setManualPhone, manualName, setManualName, manualCalling, logs, activeCall, postCall, hangup, micMuted, toggleMicMute } = props;
  const presence = getSdrPresence({ connecting, connected, sdrReady, available, activeCall, postCall, manualCalling });
  const presenceInfo = presenceCopy[presence];
  const presenceStep = ['offline', 'connecting'].includes(presence) ? 1 : presence === 'connected' ? 2 : ['available', 'dialing'].includes(presence) ? 3 : 4;
  if (isSdr) return <SdrWorkspace {...props} presence={presence} presenceInfo={presenceInfo} presenceStep={presenceStep} />;
  return <OrganizerOverview {...props} />;
}

function SdrWorkspace({ status, available, connected, connecting, sdrReady, sdrs, connectSdr, disconnectSdr, setAvailability, manualDial, manualPhone, setManualPhone, manualName, setManualName, manualCalling, activeCall, postCall, finishPostCall, finishingPause, hangup, micMuted, toggleMicMute, audioReady, connectionNotice, presence, presenceInfo, presenceStep, audioDevices, selectInputDevice, selectOutputDevice, testSpeaker, inboundAudio }: AnyRow) {
  const answered = activeCall && (activeCall.phase === 'answered' || activeCall.mediaActive);
  const personal = status.personal ?? {};
  const devices = audioDevices as AudioDeviceState | undefined;
  const inbound = inboundAudio as InboundAudioLevel | undefined;
  const hearingCustomer = Boolean(activeCall?.mediaActive && inbound?.receiving);
  return <div className="sdr-workspace">
    <div className="page-heading sdr-page-heading">
      <div><span className="eyebrow">MINHA ESTAÇÃO</span><h1>Olá, {sdrs[0]?.name?.split(' ')[0] ?? 'SDR'}</h1><p>Conecte o áudio, fique disponível e concentre-se na próxima conversa.</p></div>
      <Badge tone={available ? 'success' : connected ? 'info' : 'neutral'}><i className="badge-dot"></i>{presenceInfo.label}</Badge>
    </div>

    <Panel className={`sdr-command sdr-command-${presence}`}>
      <div className="sdr-command-main"><div className="sdr-presence-icon"><Icon name={presence === 'post-call' ? 'check' : presence === 'offline' ? 'headset' : 'phone'} size={22} /></div><div><span className="eyebrow">STATUS AGORA</span><h2>{presenceInfo.label}</h2><p>{connectionNotice || status.next_action || presenceInfo.description}</p></div></div>
      <div className="sdr-command-health"><Badge tone={status.line_ready ? 'success' : 'warning'}><Icon name="phone" size={13} />{status.line_ready ? 'Linha pronta' : 'Linha indisponível'}</Badge><Badge tone={audioReady ? 'success' : 'neutral'}><Icon name={audioReady ? 'mic' : 'mic-off'} size={13} />{audioReady ? 'Áudio verificado' : 'Áudio não verificado'}</Badge></div>
      <div className="sdr-command-actions">
        {!connected ? <Button icon="plug" disabled={connecting} onClick={() => void connectSdr()}>{connecting ? 'Conectando...' : 'Conectar e testar áudio'}</Button> : <>
          <Button variant={available ? 'success' : 'primary'} icon={available ? 'check' : 'headset'} onClick={() => void setAvailability(!available)} disabled={!sdrReady || Boolean(postCall)}>{available ? 'Disponível · pausar' : 'Ficar disponível'}</Button>
          <Button variant="ghost" onClick={() => void disconnectSdr()}>Desconectar</Button>
        </>}
      </div>
      <div className="sdr-presence-progress" aria-label={`Etapa ${presenceStep} de 4`}><span className={presenceStep >= 1 ? 'active' : ''}>Conexão</span><span className={presenceStep >= 2 ? 'active' : ''}>Pronto</span><span className={presenceStep >= 3 ? 'active' : ''}>Chamada</span><span className={presenceStep >= 4 ? 'active' : ''}>Registro</span></div>
    </Panel>

    {activeCall?.lead && <Panel className={`sdr-call-console${answered ? ' is-active' : ' is-ringing'}`}>
      <div className="sdr-call-person"><span className="sdr-call-icon"><Icon name="phone" size={23} /></span><div><span className="eyebrow">{answered ? 'CONVERSA EM ANDAMENTO' : 'CHAMANDO'}</span><h2>{activeCall.lead.name || 'Contato da fila'}</h2><p>{activeCall.lead.phone} · {answered ? <><LiveTimer startedAt={activeCall.connectedAt ?? activeCall.connected_at ?? activeCall.callStartedAt} /> · {activeCall.mediaActive ? 'áudio conectado' : 'conectando áudio…'}</> : 'aguardando atendimento…'}</p></div></div>
      <div className="sdr-call-actions"><Button variant={micMuted ? 'danger' : 'secondary'} icon={micMuted ? 'mic-off' : 'mic'} onClick={toggleMicMute} aria-pressed={Boolean(micMuted)}>{micMuted ? 'Ativar microfone' : 'Mutar'}</Button><Button variant="danger" icon="close" onClick={hangup}>{answered ? 'Encerrar conversa' : 'Cancelar chamada'}</Button></div>
      {answered && <div className="sdr-call-audio-status">
        <Badge tone={hearingCustomer ? 'success' : activeCall.mediaActive ? 'warning' : 'neutral'}><Icon name={hearingCustomer ? 'check' : 'alert'} size={13} />{hearingCustomer ? 'Recebendo a voz do cliente' : activeCall.mediaActive ? 'Sem voz do cliente agora' : 'Aguardando áudio…'}</Badge>
        <span className="text-muted">Saída: {devices?.activeOutputLabel || 'padrão do sistema'}{devices?.activeInputLabel ? ` · Microfone: ${devices.activeInputLabel}` : ''}</span>
        {activeCall.mediaActive && inbound?.receiving && <span className="form-hint">Se o indicador está verde e você não ouve, o som está saindo em outro dispositivo: troque a saída no painel Áudio abaixo.</span>}
      </div>}
    </Panel>}

    {connected && devices && <Panel className="sdr-audio-panel">
      <SectionHeader eyebrow="ÁUDIO" title="Microfone e saída" description={devices.outputSelectionSupported ? 'A saída segue automaticamente o aparelho do microfone em uso. Ajuste aqui se o som estiver saindo no lugar errado.' : 'Este navegador não permite escolher a saída de áudio; o som vai para o dispositivo padrão do sistema.'} action={<Button variant="secondary" icon="play" onClick={() => void testSpeaker()}>Testar som</Button>} />
      <div className="form-row">
        <label className="sdr-audio-field"><span>Microfone</span>
          <select value={devices.selectedInputId} onChange={(event) => void selectInputDevice(event.target.value)} aria-label="Microfone">
            <option value="">Padrão do sistema{!devices.selectedInputId && devices.activeInputLabel ? ` · ${devices.activeInputLabel}` : ''}</option>
            {devices.inputs.filter((device) => !isPseudoDevice(device.deviceId)).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{describeDevice(device, index, 'input')}</option>)}
          </select>
        </label>
        <label className="sdr-audio-field"><span>Saída (fone / alto-falante)</span>
          <select value={devices.selectedOutputId} onChange={(event) => void selectOutputDevice(event.target.value)} aria-label="Saída de áudio" disabled={!devices.outputSelectionSupported}>
            <option value="">Automática{!devices.selectedOutputId ? ` · ${devices.activeOutputLabel || 'padrão do sistema'}` : ''}</option>
            {devices.outputs.filter((device) => !isPseudoDevice(device.deviceId)).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{describeDevice(device, index, 'output')}</option>)}
          </select>
        </label>
      </div>
      {!devices.permissionGranted && <span className="form-hint">Os nomes dos dispositivos aparecem depois de você permitir o microfone.</span>}
      <span className="form-hint">Fone Bluetooth sem som durante a chamada? Ao abrir o microfone, o Windows troca o fone para o perfil Hands-Free e a saída "Stereo" fica muda. A opção Automática já escolhe a saída do mesmo fone; se ainda assim não ouvir, selecione a saída "Hands-Free" do fone ou use um fone com fio, e confirme com Testar som.</span>
    </Panel>}

    {postCall && <PostCallPanel pause={postCall} onFinish={finishPostCall} submitting={Boolean(finishingPause)} canContinue={Boolean(connected && sdrReady)} />}

    {!activeCall && !postCall && <div className="sdr-summary-grid">
      <article><span>Conversas · 24h</span><strong>{personal.answered ?? 0}</strong><small>{personal.calls ?? 0} tentativas atribuídas</small></article>
      <article><span>Tempo em conversa</span><strong>{formatDurationCompact(personal.conversation_seconds ?? 0)}</strong><small>últimas 24 horas</small></article>
      <article><span>Fila pronta</span><strong>{status.queue?.ready ?? 0}</strong><small>{status.queue?.waiting ?? 0} aguardando horário</small></article>
    </div>}

    {!activeCall && !postCall && <Panel><SectionHeader eyebrow="PRÓXIMOS RETORNOS" title="Sua agenda" action={<Badge tone={status.overdue_callbacks ? 'warning' : 'info'}>{status.overdue_callbacks ?? 0} atrasados</Badge>} /><div className="queue-list">{(status.callbacks ?? []).map((item: AnyRow) => <div className="queue-row" key={item.id}><span className="queue-position"><Icon name="calendar" size={14} /></span><div><strong>{item.lead_name}</strong><small>{item.lead_phone}</small></div><span className={item.overdue ? 'text-warning' : 'text-muted'}>{new Date(item.due_at).toLocaleString('pt-BR')}</span></div>)}{!(status.callbacks ?? []).length && <EmptyState title="Nenhum retorno agendado" description="Seus próximos retornos aparecerão aqui." />}</div></Panel>}

    {!activeCall && !postCall && <div className="sdr-secondary-grid"><Panel>
      <SectionHeader eyebrow="DISCAGEM MANUAL" title="Ligar para um telefone" description="Use apenas quando precisar ligar fora da fila automática." />
      <form className="form-row" onSubmit={(event) => void manualDial(event)}><input type="tel" placeholder="Telefone com DDD" value={manualPhone} onChange={(event) => setManualPhone(event.target.value)} aria-label="Telefone para discagem manual" required /><input placeholder="Nome do contato (opcional)" value={manualName} onChange={(event) => setManualName(event.target.value)} aria-label="Nome do contato" /><Button variant="success" icon="phone" disabled={manualCalling || !connected || !sdrReady}>{manualCalling ? 'Iniciando...' : 'Ligar agora'}</Button></form>
    </Panel><Panel className="sdr-readiness"><SectionHeader eyebrow="PRONTIDÃO" title="Antes da próxima conversa" /><ul><li className={status.line_ready ? 'done' : ''}><Icon name={status.line_ready ? 'check' : 'alert'} size={15} />Linha do WhatsApp disponível</li><li className={audioReady ? 'done' : ''}><Icon name={audioReady ? 'check' : 'mic'} size={15} />Microfone permitido e verificado</li><li className={available ? 'done' : ''}><Icon name={available ? 'check' : 'headset'} size={15} />Você está disponível na fila</li></ul></Panel></div>}
  </div>;
}
