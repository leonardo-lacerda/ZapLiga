import { useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel } from '../../components/ui';
import { JobTimeline } from './JobTimeline';
import { LiveScreen } from './LiveScreen';
import { ProfileForm } from './ProfileForm';
import { SmsCodeInput } from './SmsCodeInput';
import { createObjectUrl, revokeObjectUrl } from './objectUrl';
import { cancelJob, fetchJobScreenshot, requestNewCode, resumeRobot, submitLinkDecision, submitProfile, submitSmsCode, takeOverJob } from './provisioning.api';
import { appLabels, errorExplanation, formatPhone, isControl, isJobActive, isNetworkCheck, splitJobNumber, statusLabels, statusTone, stepLabel } from './provisioning.labels';
import type { Job, WizardPrefill } from './provisioning.types';
import { JOB_POLL_INTERVAL_MS, useProvisioningJob } from './useProvisioningJob';

type Props = {
  tenantId: string;
  jobId: string;
  pollIntervalMs?: number;
  onBack: () => void;
  onNewJob: (prefill?: WizardPrefill) => void;
  onOpenNumbers: () => void;
};

const linkingSteps = new Set(['creating_line', 'opening_link_screen', 'waiting_pair_code', 'entering_pair_code', 'linking']);
/** Depois de um erro o worker deixa o phone ligado este tempo (RESCUE_WINDOW no worker). */
export const RESCUE_SECONDS = 59;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const retryPrefill = (job: Job): WizardPrefill => {
  if (isNetworkCheck(job)) return { egressNode: job.egressNode, phoneId: job.geelarkPhoneId };
  const { countryCode, number } = splitJobNumber(job.number);
  return { egressNode: job.egressNode, phoneId: job.geelarkPhoneId, ...(job.app ? { app: job.app } : {}), ...(countryCode ? { countryCode, number } : {}) };
};

/** Tela de progresso: consulta o job a cada 2 s e pede ao usuário o que o robô precisa. */
export function JobProgress({ tenantId, jobId, pollIntervalMs = JOB_POLL_INTERVAL_MS, onBack, onNewJob, onOpenNumbers }: Props) {
  const { job, applyJob, loadError, notFound } = useProvisioningJob(tenantId, jobId, pollIntervalMs);
  const [actionError, setActionError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [takingOver, setTakingOver] = useState(false);

  const run = async (action: () => Promise<Job>) => {
    setActionError('');
    try { applyJob(await action()); return true; }
    catch (error) { setActionError(errorText(error)); return false; }
  };

  const cancel = async () => {
    if (!window.confirm(isNetworkCheck(job ?? {}) ? 'Cancelar este teste? O phone é desligado.' : 'Cancelar este cadastro? O robô para e o phone é desligado.')) return;
    setCancelling(true);
    try { await run(() => cancelJob(tenantId, jobId)); } finally { setCancelling(false); }
  };

  if (notFound) {
    return <Panel className="provisioning-result is-error"><h2>Cadastro não encontrado</h2><p>Este cadastro não existe mais ou pertence a outra empresa.</p><div className="provisioning-inline-actions"><Button variant="ghost" onClick={onBack}>Voltar</Button></div></Panel>;
  }
  if (!job) {
    return <Panel className="provisioning-progress">{loadError ? <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{loadError}</span></div> : <p className="subtle">Carregando o cadastro…</p>}</Panel>;
  }

  const active = isJobActive(job);
  const network = isNetworkCheck(job);
  const control = isControl(job);
  // Na sessão "Abrir", quem desliga é o botão do cartão; aqui só antes de o phone ficar pronto.
  const controlReady = control && job.step === 'controlling';
  // Com o robô andando: o operador pede o controle; o robô para na próxima tela do WhatsApp.
  const canTakeOver = active && !network && !control && job.status === 'running' && !linkingSteps.has(job.step);
  const pausing = canTakeOver && (job.message ?? '').startsWith('Pausando o robô');
  const takeOver = async () => {
    setTakingOver(true);
    try { await run(() => takeOverJob(tenantId, jobId)); } finally { setTakingOver(false); }
  };
  return <div className="provisioning-progress-layout">
    <Panel className="provisioning-progress">
      <div className="detail-heading">
        <div>
          <span className="eyebrow">{network ? 'TESTE DE INTERNET' : control ? 'TELEFONE' : `CADASTRO ${(job.app && appLabels[job.app]?.toUpperCase()) ?? ''}`}</span>
          <h2>{network || control ? (job.phoneName ?? job.geelarkPhoneId) : formatPhone(job.number)}</h2>
          <p>{network || control ? 'Telefone' : `Phone ${job.phoneName ?? job.geelarkPhoneId}`} · saída pelo PC do atendente{job.egressIp ? ` (IP ${job.egressIp})` : ''}</p>
        </div>
        <Badge tone={statusTone[job.status] ?? 'neutral'}>{statusLabels[job.status] ?? job.status}</Badge>
      </div>

      {loadError && <div className="alert alert-warning" role="status"><Icon name="alert" size={17} /><span>{loadError}</span></div>}
      {actionError && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{actionError}</span><button type="button" onClick={() => setActionError('')} aria-label="Fechar erro"><Icon name="close" size={16} /></button></div>}

      <div className="provisioning-action">
        <JobAction job={job} tenantId={tenantId} run={run} onNewJob={onNewJob} onOpenNumbers={onOpenNumbers} />
      </div>
      {canTakeOver && <div className="provisioning-takeover">
        <Button variant="secondary" icon="phone" onClick={() => void takeOver()} disabled={takingOver || pausing}>{pausing ? 'Pausando o robô…' : takingOver ? 'Pedindo…' : 'Assumir o controle'}</Button>
        <span className="form-hint">O robô para na próxima tela e você mexe no phone pela imagem abaixo.</span>
      </div>}
      {active && <LiveScreen tenantId={tenantId} jobId={job.id} controllable={job.status === 'waiting_input'} />}

      <div className="provisioning-inline-actions">
        {active && !controlReady && <Button variant="danger" icon="close" onClick={() => void cancel()} disabled={cancelling}>{cancelling ? 'Cancelando…' : network ? 'Cancelar teste' : control ? 'Cancelar e desligar' : 'Cancelar cadastro'}</Button>}
        <Button variant="ghost" onClick={onBack}>{active ? (network ? 'Voltar (o teste continua)' : control ? 'Voltar (o telefone continua ligado)' : 'Voltar (o cadastro continua)') : 'Voltar'}</Button>
      </div>
    </Panel>
    <Panel className="provisioning-timeline-panel">
      <div className="section-header"><div><h2>Andamento</h2></div></div>
      <JobTimeline job={job} />
    </Panel>
  </div>;
}

type ActionProps = {
  job: Job;
  tenantId: string;
  run: (action: () => Promise<Job>) => Promise<boolean>;
  onNewJob: (prefill?: WizardPrefill) => void;
  onOpenNumbers: () => void;
};

function JobAction({ job, tenantId, run, onNewJob, onOpenNumbers }: ActionProps) {
  if (job.status === 'done' && isNetworkCheck(job)) {
    return <div className="provisioning-result is-success" role="status">
      <Icon name="check" size={20} />
      <h3>Internet do telefone ok</h3>
      <p>{job.message ?? 'O telefone saiu pela internet do PC escolhido.'} Ele já foi desligado.</p>
      <div className="provisioning-inline-actions">
        <Button icon="phone" onClick={() => onNewJob({ egressNode: job.egressNode, phoneId: job.geelarkPhoneId })}>Cadastrar número neste telefone</Button>
      </div>
    </div>;
  }
  if (isControl(job) && (job.status === 'done' || job.status === 'cancelled')) {
    return <div className="provisioning-result" role="status">
      <h3>Sessão encerrada</h3>
      <p>{job.status === 'done' && job.message ? job.message : 'O telefone foi desligado e parou de cobrar.'}</p>
    </div>;
  }
  if (job.status === 'waiting_input' && job.step === 'controlling') return <ControlSession job={job} tenantId={tenantId} run={run} />;
  if (job.status === 'done') {
    return <div className="provisioning-result is-success" role="status">
      <Icon name="check" size={20} />
      {job.linked
        ? <><h3>Número cadastrado e conectado ao ZapLiga</h3><p>A linha já aparece em Números, pronta para uso.</p></>
        : <><h3>Número cadastrado no WhatsApp</h3><p>O número foi registrado, mas não foi conectado ao ZapLiga. Para usar nas ligações, crie a sessão em Números e conecte pelo QR Code.</p></>}
      <div className="provisioning-inline-actions">
        <Button icon="phone" onClick={onOpenNumbers}>{job.linked ? 'Ver em Números' : 'Ir para Números'}</Button>
        <Button variant="ghost" icon="plus" onClick={() => onNewJob()}>Cadastrar outro número</Button>
      </div>
    </div>;
  }
  if (job.status === 'failed') return <FailedJob job={job} tenantId={tenantId} onNewJob={onNewJob} onOpenNumbers={onOpenNumbers} />;
  if (job.status === 'cancelled') {
    return <div className="provisioning-result" role="status">
      <h3>{isNetworkCheck(job) ? 'Teste cancelado' : 'Cadastro cancelado'}</h3><p>O processo foi interrompido{job.message ? `: ${job.message}` : '.'}</p>
      <div className="provisioning-inline-actions"><Button variant="secondary" icon="refresh" onClick={() => onNewJob(retryPrefill(job))}>Tentar de novo</Button></div>
    </div>;
  }

  if (job.status === 'waiting_input' && job.awaiting === 'sms') {
    const retried = (job.history ?? []).some((entry) => entry.step === 'verifying');
    return <div className="provisioning-input-card">
      <h3>Digite o código que chegou por SMS</h3>
      <p>O WhatsApp enviou um código de 6 dígitos para {formatPhone(job.number)}.</p>
      {job.message && (retried
        ? <div className="alert alert-warning" role="alert"><Icon name="alert" size={17} /><span>{job.message}</span></div>
        : <p className="form-hint">{job.message}</p>)}
      <SmsCodeInput onSubmit={(code) => run(() => submitSmsCode(tenantId, job.id, code))} />
      <ResendCode job={job} tenantId={tenantId} run={run} />
    </div>;
  }
  if (job.status === 'waiting_input' && job.awaiting === 'profile') {
    return <div className="provisioning-input-card">
      <h3>Nome e foto do perfil</h3>
      <p>O número foi confirmado. Agora escolha como ele aparece no WhatsApp.</p>
      <ProfileForm onSubmit={(input) => run(() => submitProfile(tenantId, job.id, input))} />
    </div>;
  }
  if (job.status === 'waiting_input' && job.awaiting === 'link_decision') return <LinkDecision job={job} tenantId={tenantId} run={run} />;
  if (job.status === 'waiting_input' && job.step === 'rescue_offer') return <RescueOffer job={job} tenantId={tenantId} run={run} />;
  if (job.status === 'waiting_input' && job.awaiting === 'manual') return <ManualHelp job={job} tenantId={tenantId} run={run} />;

  const linking = job.awaiting === 'pair_code' || linkingSteps.has(job.step);
  return <div className="provisioning-working" role="status" aria-live="polite">
    <span className="provisioning-spinner" aria-hidden="true" />
    <div>
      <strong>{linking ? 'Conectando ao ZapLiga…' : `${stepLabel(job.step)}…`}</strong>
      <small>{job.message ?? (linking ? 'O robô está digitando o código de conexão no phone. Não precisa fazer nada.' : 'O robô está trabalhando. Esta tela atualiza sozinha.')}</small>
    </div>
  </div>;
}

/** "Abrir o telefone": ligado, saindo pelo PC, com o operador mexendo pela tela ao vivo. */
function ControlSession({ job, tenantId, run }: { job: Job; tenantId: string; run: ActionProps['run'] }) {
  const [busy, setBusy] = useState(false);
  const end = async () => {
    setBusy(true);
    try { await run(() => resumeRobot(tenantId, job.id)); } finally { setBusy(false); }
  };
  return <div className="provisioning-input-card">
    <h3>Telefone aberto: está com você</h3>
    <p>Clique na tela abaixo para tocar, use os botões para voltar, ir para o início e digitar. Ninguém mais mexe nele enquanto isso.</p>
    {job.message && <p className="provisioning-detail">{job.message}</p>}
    <div className="provisioning-inline-actions">
      <Button variant="danger" icon="close" onClick={() => void end()} disabled={busy}>{busy ? 'Desligando…' : 'Desligar o phone'}</Button>
    </div>
    <p className="form-hint">Ligado, ele cobra por minuto. Sem nenhum toque por 10 minutos (ou depois de 30 minutos no total), desliga sozinho.</p>
  </div>;
}

/** O SMS não chegou: o robô aperta "Reenviar SMS" ou "Ligar para mim" quando o WhatsApp liberar. */
function ResendCode({ job, tenantId, run }: { job: Job; tenantId: string; run: ActionProps['run'] }) {
  const [busy, setBusy] = useState<'' | 'sms' | 'voice'>('');
  const ask = async (method: 'sms' | 'voice') => {
    setBusy(method);
    try { await run(() => requestNewCode(tenantId, job.id, method)); } finally { setBusy(''); }
  };
  return <div className="provisioning-resend">
    <span className="form-hint">Não chegou? Olhe a tela do phone abaixo: se o WhatsApp mandou o código para outro aparelho, ele avisa ali.</span>
    <div className="provisioning-inline-actions">
      <Button variant="secondary" icon="refresh" onClick={() => void ask('sms')} disabled={Boolean(busy)}>{busy === 'sms' ? 'Pedindo…' : 'Reenviar SMS'}</Button>
      <Button variant="secondary" icon="phone" onClick={() => void ask('voice')} disabled={Boolean(busy)}>{busy === 'voice' ? 'Pedindo…' : 'Receber por ligação'}</Button>
    </div>
  </div>;
}

/** Quando a contagem começou: hora do servidor; com relógio muito diferente, a hora em que a tela viu. */
const rescueStartedAt = (job: Job, seenAt: number) => {
  const entry = [...(job.history ?? [])].reverse().find((item) => item.step === 'rescue_offer');
  const at = Date.parse(entry?.at ?? '');
  const elapsed = Date.now() - at;
  return Number.isFinite(at) && elapsed >= 0 && elapsed <= (RESCUE_SECONDS + 30) * 1000 ? at : seenAt;
};

/** O robô falhou mas o phone ainda está ligado: 59 s para o operador assumir antes de desligar. */
function RescueOffer({ job, tenantId, run }: { job: Job; tenantId: string; run: ActionProps['run'] }) {
  const [seenAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil(RESCUE_SECONDS - (now - rescueStartedAt(job, seenAt)) / 1000));
  const claiming = busy || (job.message ?? '').startsWith('Assumindo o controle');
  const claim = async () => {
    setBusy(true);
    try { await run(() => takeOverJob(tenantId, job.id)); } finally { setBusy(false); }
  };
  const explanation = errorExplanation(job.errorCode);
  return <div className="provisioning-result is-error provisioning-rescue" role="alert">
    <Icon name="alert" size={20} />
    <h3>{explanation.title}</h3>
    {job.message && <p className="provisioning-detail">Detalhe: {job.message}</p>}
    <p className="provisioning-countdown" role="timer" aria-live="off">{left > 0 ? `O phone desliga em ${left} s` : 'Desligando o phone…'}</p>
    <div className="provisioning-inline-actions">
      <Button icon="phone" onClick={() => void claim()} disabled={claiming || left === 0}>{claiming ? 'Assumindo…' : 'Assumir o controle do phone'}</Button>
    </div>
    <p className="form-hint">Assumindo, o phone fica ligado com você (e cobrando) e depois você devolve ao robô ou cancela. Tocar na tela abaixo também assume. Sem ninguém, ele desliga para não cobrar.</p>
  </div>;
}

/** Tela que o robô não conhece: o operador passa dela pela tela ao vivo e devolve o phone. */
function ManualHelp({ job, tenantId, run }: { job: Job; tenantId: string; run: ActionProps['run'] }) {
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    setBusy(true);
    try { await run(() => resumeRobot(tenantId, job.id)); } finally { setBusy(false); }
  };
  const message = job.message ?? '';
  const taken = message.startsWith('Você assumiu o controle');
  const waitLimit = message.startsWith('O WhatsApp pediu para esperar');
  const title = taken ? 'Você está no controle do phone'
    : waitLimit ? 'O WhatsApp pediu para esperar: o phone está com você'
    : 'O robô parou numa tela que não conhece';
  return <div className="provisioning-input-card">
    <h3>{title}</h3>
    <p>Clique na tela do phone abaixo para tocar nela, como num celular, até passar desta tela. Depois devolva o phone ao robô: ele continua de onde estiver.</p>
    {job.message && <p className="provisioning-detail">{job.message}</p>}
    <div className="provisioning-inline-actions">
      <Button icon="check" onClick={() => void resume()} disabled={busy}>{busy ? 'Devolvendo…' : 'Devolver ao robô'}</Button>
    </div>
    <p className="form-hint">O phone continua ligado (e cobrando) enquanto espera você.</p>
  </div>;
}

function LinkDecision({ job, tenantId, run }: { job: Job; tenantId: string; run: ActionProps['run'] }) {
  const [connect, setConnect] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await run(() => submitLinkDecision(tenantId, job.id, connect)); } finally { setBusy(false); }
  };
  return <div className="provisioning-input-card">
    <h3>Número registrado no WhatsApp</h3>
    <p>Quer que esta linha já entre no ZapLiga? A conexão é feita pelo próprio phone, sem QR Code.</p>
    <label className="provisioning-switch">
      <input type="checkbox" role="switch" checked={connect} onChange={(event) => setConnect(event.target.checked)} />
      <span>Conectar ao ZapLiga por telefone + código (sem QR Code)</span>
    </label>
    <div className="provisioning-inline-actions">
      <Button icon={connect ? 'plug' : 'check'} onClick={() => void submit()} disabled={busy}>{busy ? 'Enviando…' : connect ? 'Conectar ao ZapLiga' : 'Concluir sem conectar'}</Button>
    </div>
  </div>;
}

function FailedJob({ job, tenantId, onNewJob, onOpenNumbers }: Omit<ActionProps, 'run'>) {
  const explanation = errorExplanation(job.errorCode);
  const [screenshot, setScreenshot] = useState('');
  const [screenshotError, setScreenshotError] = useState(false);

  useEffect(() => {
    if (!job.hasScreenshot) return undefined;
    let closed = false;
    let url = '';
    fetchJobScreenshot(tenantId, job.id)
      .then((blob) => { if (closed) return; url = createObjectUrl(blob); setScreenshot(url); })
      .catch(() => { if (!closed) setScreenshotError(true); });
    return () => { closed = true; revokeObjectUrl(url); };
  }, [tenantId, job.id, job.hasScreenshot]);

  const lineCreated = job.errorCode === 'link_timeout' || job.errorCode === 'pair_failed' || Boolean(job.numberId);
  return <div className="provisioning-result is-error" role="alert">
    <Icon name="alert" size={20} />
    <h3>{explanation.title}</h3>
    <p>{explanation.hint}</p>
    {job.message && <p className="provisioning-detail">Detalhe: {job.message}</p>}
    {job.hasScreenshot && (screenshot
      ? <figure className="provisioning-screenshot"><img src={screenshot} alt="Print da tela do phone no momento do erro" /><figcaption>Tela do phone no momento do erro</figcaption></figure>
      : <p className="subtle">{screenshotError ? 'Não foi possível carregar o print da tela.' : 'Carregando o print da tela…'}</p>)}
    <div className="provisioning-inline-actions">
      <Button variant="secondary" icon="refresh" onClick={() => onNewJob(retryPrefill(job))}>Tentar de novo</Button>
      {lineCreated && <Button variant="ghost" icon="phone" onClick={onOpenNumbers}>Ir para Números</Button>}
    </div>
  </div>;
}
