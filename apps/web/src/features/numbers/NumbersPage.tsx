import { useEffect, useState } from 'react';
import type React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';
import { Badge, Button, EmptyState, Icon, Pagination, Panel, SectionHeader } from '../../components/ui';
import { PAGE_SIZE, formatNumber, labelStatus } from '../../shared/format';
import { formatBytes } from '../access/AdminProxyPanel';
import { STEALTH_COVERAGE_COPY, STEALTH_HINT, STEALTH_LABEL } from './stealth.copy';
import { DeviceProfileChoice, MultiloginPhoneSelect, useMultiloginPhones } from './DeviceProfileChoice';
import { DEVICE_PROFILE_CREATE_HINT, DEVICE_PROFILE_OPTION_NEW } from './deviceProfile.copy';
import { LOSS_CAUSE_ACTION, LOSS_CAUSE_LABEL, REGISTRATION_REASON_LABEL } from './lineLoss.copy';

const connectedStatuses = ['connected', 'online', 'ready', 'authenticated', 'logged_in'];

function updateNumberField(setNumberForm: AnyRow['setNumberForm'], numberForm: AnyRow, field: string, value: string | number) {
  setNumberForm({ ...numberForm, [field]: value });
}

// `canProvision`: flag whatsapp_provisioning + papel leader/super_admin (calculado em App com canUseProvisioning).
// `canManageStealth`: super admin; liga a camuflagem por linha (docs/stealth-profile.md).
export function NumbersPage({ numbers, numbersTotal, numbersOffset, onNumbersPageChange, numberForm, setNumberForm, createNumber, showQr, reconnectNumber, removeNumber, qrLoading, qr, qrNumberId, closeQr, canManageNumbers = false, canProvision = false, onOpenProvisioning, canaryCall, stationReady = false, canManageStealth = false }: AnyRow) {
  const [pairNumber, setPairNumber] = useState<AnyRow | null>(null);
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">WHATSAPP</span><h1>Números</h1><p>{canManageNumbers ? 'Gerencie as sessões conectadas à sua operação.' : 'Consulte as sessões conectadas à sua operação.'}</p></div>
      <div className="page-heading-actions">
        {canProvision && <Button variant="secondary" icon="plus" onClick={() => onOpenProvisioning?.()}>Cadastrar número no GeeLark</Button>}
        <Badge tone="info">{formatNumber(numbersTotal)} sessões</Badge>
      </div>
    </div>
    <LossSummary />
    {canManageNumbers && <Panel>
      <SectionHeader title="Adicionar número" description="Crie uma sessão e conecte o WhatsApp pelo QR Code ou por código (com o número de telefone)." />
      <form className="number-create-form" onSubmit={createNumber}>
        <div className="number-form-section">
          <div className="number-form-section-head">
            <strong>Identificação</strong>
            <span>Como esta linha aparece na operação. O telefone é opcional e pode ser preenchido após o QR.</span>
          </div>
          <div className="number-form-grid">
            <label>
              <span>Nome da linha <em>*</em></span>
              <input
                name="label"
                value={numberForm.label}
                onChange={(e) => updateNumberField(setNumberForm, numberForm, 'label', e.target.value)}
                placeholder="Ex.: Comercial SP"
                required
                minLength={2}
                autoComplete="off"
              />
              <small>Apelido interno para identificar a sessão (mín. 2 caracteres).</small>
            </label>
            <label>
              <span>Telefone <small>opcional</small></span>
              <input
                name="phone"
                value={numberForm.phone}
                onChange={(e) => updateNumberField(setNumberForm, numberForm, 'phone', e.target.value)}
                placeholder="Ex.: 5511999999999"
                inputMode="tel"
                autoComplete="tel"
              />
              <small>Com DDI, sem espaços. Se vazio, o sistema preenche após conectar.</small>
            </label>
          </div>
        </div>

        {canManageStealth && <details className="line-settings">
          <summary><span>Camuflagem da linha</span><small>Só o admin do ZapLiga</small></summary>
          <div className="line-settings-body">
            <label className="line-setting">
              <span>{STEALTH_LABEL}<small>{STEALTH_HINT}</small></span>
              <input type="checkbox" name="stealth" checked={Boolean(numberForm.stealth)} onChange={(e) => setNumberForm({ ...numberForm, stealth: e.target.checked })} />
            </label>
            <CreateDeviceProfileField numberForm={numberForm} setNumberForm={setNumberForm} />
          </div>
        </details>}

        <div className="number-form-footer">
          <p className="form-hint">A linha nasce com os limites de <strong>Configurações do discador</strong> (chamadas simultâneas e proteção entre chamadas). Depois de criar, conecte pelo card da sessão: <strong>Abrir QR</strong> (escanear com o celular) ou <strong>Conectar por código</strong> (digitar um código no WhatsApp do celular).</p>
          <Button icon="plus">Criar sessão</Button>
        </div>
      </form>
    </Panel>}
    <div className="line-grid">
      {numbers.map((number: AnyRow) => {
        const connected = connectedStatuses.includes(String(number.status).toLowerCase());
        const lost = Boolean(number.loss_cause || number.loss_reason) || Number(number.removal_count ?? 0) >= RETIRED_AFTER_LOSSES;
        return <article className={`line-card ${lost ? 'is-lost' : connected ? 'is-connected' : 'is-waiting'}`} key={number.id}>
          <header className="line-card-head">
            <div><h3>{number.label}</h3><p>{formatPhone(number.phone) || 'Telefone não informado'}</p></div>
            <Badge tone={connected ? 'success' : lost ? 'error' : 'neutral'}>{labelStatus(number.status)}</Badge>
          </header>
          <LineAlerts number={number} />
          <LineStats number={number} />
          {!canManageNumbers && <VerificationOnlyToggle number={number} canManage={false} />}
          {canManageNumbers && <RegistrationReasonForm number={number} />}
          {canManageNumbers && <CanaryStep number={number} canaryCall={canaryCall} stationReady={stationReady} />}
          {canManageNumbers && <div className="line-actions">
            {!connected && <><Button variant="secondary" icon="qr" disabled={qrLoading} onClick={() => void showQr(number.id)}>Abrir QR</Button><Button variant="secondary" icon="phone" disabled={qrLoading} onClick={() => setPairNumber(number)}>Conectar por código</Button></>}
            <span className="line-actions-more">
              <Button variant="ghost" icon="refresh" disabled={qrLoading} onClick={() => void reconnectNumber(number.id)}>Reconectar</Button>
              <Button variant="danger" icon="close" disabled={qrLoading} onClick={() => void removeNumber(number.id, number.label)}>Remover</Button>
            </span>
          </div>}
          {(canManageNumbers || canManageStealth) && <LineSettings number={number} canManageNumbers={canManageNumbers} canManageStealth={canManageStealth} />}
        </article>;
      })}
      {!numbers.length && <div className="full-span"><EmptyState title="Nenhum número cadastrado" description={canManageNumbers ? 'Adicione uma sessão para conectar seu WhatsApp.' : 'Os números serão configurados pelo administrador da plataforma.'} /></div>}
    </div>
    <Pagination offset={numbersOffset} limit={PAGE_SIZE} total={numbersTotal} onChange={onNumbersPageChange} />
    {qr && <QrModal qr={qr} closeQr={closeQr} numberId={qrNumberId} defaultPhone={numbers.find((number: AnyRow) => number.id === qrNumberId)?.phone ?? ''} />}
    {pairNumber && <PairCodeModal number={pairNumber} onClose={() => setPairNumber(null)} />}
  </>;
}

// Quarentena da linha (24 h após cada pareamento, ou proteção contra bloqueio): o discador não a usa.
function CallBlock({ flaggedUntil }: { flaggedUntil?: string | null }) {
  if (!flaggedUntil || new Date(flaggedUntil).getTime() <= Date.now()) return null;
  const until = new Date(flaggedUntil).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return <p className="line-alert is-warning">Ligações bloqueadas até {until}</p>;
}

const RETIRED_AFTER_LOSSES = 2;
const YOUNG_LINE_DAILY_CALLS = 60;
const LOSS_SUMMARY_DAYS = 30;
const formatWhen = (value: string) => new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// Quedas dos últimos 30 dias por causa, para a operação decidir com dados.
function LossSummary() {
  const [causes, setCauses] = useState<AnyRow[]>([]);
  useEffect(() => {
    let active = true;
    json('/api/numbers/loss-causes').then((summary) => { if (active) setCauses(summary?.causes ?? []); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!causes.length) return null;
  return <Panel>
    <SectionHeader title={`Quedas em ${LOSS_SUMMARY_DAYS} dias`} description="Cada sinal que o WhatsApp mandou sobre a saúde das linhas, por causa." />
    <div className="card-actions">{causes.map((item) => <Badge key={item.cause} tone={['transient', 'unknown'].includes(item.cause) ? 'neutral' : 'warning'}>{LOSS_CAUSE_LABEL[item.cause] ?? item.cause}: {item.total} ({item.lines} {Number(item.lines) === 1 ? 'linha' : 'linhas'})</Badge>)}</div>
  </Panel>;
}

// Pausa que o WhatsApp impôs (banimento temporário, limite de alcance) ou ligação sem áudio: a linha não disca até o prazo.
function DialPause({ number }: { number: AnyRow }) {
  if (!number.dial_blocked_until || new Date(number.dial_blocked_until).getTime() <= Date.now()) return null;
  return <p className="line-alert is-warning">Pausadas até {formatWhen(number.dial_blocked_until)} · {LOSS_CAUSE_LABEL[number.dial_block_cause] ?? 'sinal do WhatsApp'}</p>;
}

// O que o celular mostrou quando o WhatsApp recusou o registro: só a operação vê isso, então registra aqui.
function RegistrationReasonForm({ number }: { number: AnyRow }) {
  const [reason, setReason] = useState<string>(number.registration_reason ?? '');
  const [saved, setSaved] = useState<string>(number.registration_reason ?? '');
  const [error, setError] = useState('');
  if (connectedStatuses.includes(String(number.status).toLowerCase()) && !number.loss_reason) return null;
  const save = async () => {
    setError('');
    try { await json(`/api/numbers/${number.id}/registration-reason`, { method: 'POST', body: JSON.stringify({ reason }) }); setSaved(reason); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <div className="line-task">
    <span>O que o celular mostrou?<small>Se o WhatsApp recusou o número no celular, registre o motivo para a operação saber o que fazer.</small></span>
    <div className="form-row">
      <select aria-label={`Motivo da recusa de ${number.label}`} value={reason} onChange={(event) => setReason(event.target.value)}>
        <option value="">Selecione</option>
        {Object.entries(REGISTRATION_REASON_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <Button variant="secondary" icon="check" disabled={!reason || reason === saved} onClick={() => void save()}>Registrar</Button>
    </div>
    {error && <div className="alert" role="alert"><Icon name="alert" /><span>{error}</span></div>}
  </div>;
}

const formatPhone = (value: unknown) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return match ? `+55 ${match[1]} ${match[2]}-${match[3]}` : digits;
};

// O que pede atenção na linha, em frases curtas: aposentada, por que caiu, bloqueio e pausa das ligações.
function LineAlerts({ number }: { number: AnyRow }) {
  const retired = Number(number.removal_count ?? 0) >= RETIRED_AFTER_LOSSES;
  const cause = number.loss_cause ?? number.loss_reason;
  return <>
    {retired && <p className="line-alert is-error">Aposentada: o WhatsApp tirou este número {number.removal_count} vezes</p>}
    {!retired && cause && <p className="line-alert is-error">{LOSS_CAUSE_ACTION[cause] ?? cause}</p>}
    {number.loss_detail?.violationReason && <p className="line-alert is-error">Motivo informado: <strong>{number.loss_detail.violationReason}</strong></p>}
    <CallBlock flaggedUntil={number.flagged_until} />
    <DialPause number={number} />
  </>;
}

// Os números da linha: limites, ligações de hoje (linha jovem), reconexões, quedas e rede da proxy.
function LineStats({ number }: { number: AnyRow }) {
  const losses = number.losses_recent && Object.keys(number.losses_recent).length > 0
    ? Object.entries(number.losses_recent).map(([cause, total]) => `${LOSS_CAUSE_LABEL[cause] ?? cause} ${total}`).join(' · ')
    : null;
  return <dl className="line-stats">
    <div><dt>Limite de chamadas</dt><dd>{number.max_concurrent_calls}</dd></div>
    <div><dt>Cadência protegida</dt><dd>{number.max_calls_per_window ?? 3} / {number.call_window_seconds ?? 180}s</dd></div>
    {number.young && <div><dt>Ligações hoje</dt><dd>{number.calls_today ?? 0}/{YOUNG_LINE_DAILY_CALLS}</dd></div>}
    {Number(number.reconnects_24h ?? 0) > 0 && <div><dt>Reconexões em 24 h</dt><dd>{number.reconnects_24h}</dd></div>}
    {losses && <div className="is-wide"><dt>Quedas em {LOSS_SUMMARY_DAYS} dias</dt><dd>{losses}</dd></div>}
    {number.network_month_bytes != null && <div className="is-wide"><dt>Rede da proxy</dt><dd>hoje {formatBytes(number.network_today_bytes)} · mês {formatBytes(number.network_month_bytes)}</dd></div>}
  </dl>;
}

const DEVICE_PROFILE_SUMMARY: Record<string, string> = { pending: 'Nova camuflagem: no próximo pareamento', active: 'Nova camuflagem', leaving: 'Nova camuflagem: sai no próximo pareamento' };

// Ajustes que mudam pouco: recolhidos, com um resumo do que está ligado.
function LineSettings({ number, canManageNumbers, canManageStealth }: { number: AnyRow; canManageNumbers: boolean; canManageStealth: boolean }) {
  const on = [
    number.verification_only && 'Só verificação',
    canManageStealth && number.stealth_enabled && 'Camuflagem de navegador',
    canManageStealth && DEVICE_PROFILE_SUMMARY[number.device_profile_state ?? ''],
  ].filter(Boolean) as string[];
  return <details className="line-settings">
    <summary><span>Ajustes da linha</span>{on.map((item) => <Badge key={item} tone="info">{item}</Badge>)}</summary>
    <div className="line-settings-body">
      {canManageNumbers && <VerificationOnlyToggle number={number} canManage />}
      <StealthToggle number={number} canManage={canManageStealth} />
      <DeviceProfileChoice number={number} canManage={canManageStealth} />
    </div>
  </details>;
}

/**
 * Canário: depois de cada pareamento, a primeira ligação da linha vai para o celular de alguém da
 * equipe, nunca para um lead. A linha manda uma mensagem, a pessoa responde e quem está na estação
 * liga. Se a ligação passar de alguns segundos e a linha seguir conectada, ela é liberada.
 */
function CanaryStep({ number, canaryCall, stationReady }: { number: AnyRow; canaryCall?: (numberId: string, phone: string) => Promise<void>; stationReady: boolean }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [released, setReleased] = useState(false);
  if (released || number.canary_status === 'passed' || number.loss_reason || Number(number.removal_count ?? 0) >= RETIRED_AFTER_LOSSES) return null;
  const blocked = number.flagged_until && new Date(number.flagged_until).getTime() > Date.now();
  const connected = connectedStatuses.includes(String(number.status).toLowerCase());
  const sendMessage = async () => {
    setBusy(true); setError('');
    try { setPhone((await json(`/api/numbers/${number.id}/canary/message`, { method: 'POST' }))?.phone ?? ''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const call = async () => {
    setBusy(true); setError('');
    try { await canaryCall?.(number.id, phone); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const release = async () => {
    if (!window.confirm(`Liberar ${number.label} para ligar para leads sem a ligação de teste? Se o WhatsApp for derrubar a linha na primeira ligação, isso vai acontecer com um lead.`)) return;
    setBusy(true); setError('');
    try { await json(`/api/numbers/${number.id}/canary/pass`, { method: 'POST' }); setReleased(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <div className="line-task">
    <span>{number.canary_status === 'failed' ? 'Canário reprovado: tente de novo depois do descanso' : 'Aguardando canário'}<small>A primeira ligação depois do QR vai para o celular de alguém da equipe, nunca para um lead. Só depois a linha liga para leads.</small></span>
    {connected && !blocked && <div className="card-actions">
      {!phone && <Button variant="secondary" icon="note" disabled={busy} onClick={() => void sendMessage()}>1. Enviar mensagem</Button>}
      {phone && <><small>Mensagem enviada para {phone}. Peça para a pessoa responder, ligue, converse uns 30 segundos e desligue.</small><Button variant="secondary" icon="phone" disabled={busy || !stationReady} onClick={() => void call()}>2. Ligar para {phone}</Button></>}
      {phone && !stationReady && <small>Conecte sua estação de ligação para ligar.</small>}
    </div>}
    <div className="card-actions"><Button variant="ghost" icon="check" disabled={busy} onClick={() => void release()}>Liberar sem teste</Button></div>
    {error && <div className="alert" role="alert"><Icon name="alert" /><span>{error}</span></div>}
  </div>;
}

/**
 * Linha "só para verificação": usada apenas para checar se um telefone tem WhatsApp
 * (integração com o CRM) e fica fora do discador, automático e manual.
 */
export function VerificationOnlyToggle({ number, canManage }: { number: AnyRow; canManage: boolean }) {
  const [enabled, setEnabled] = useState(Boolean(number.verification_only));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!canManage) return enabled ? <div className="resource-meta"><span>Uso</span><Badge tone="info">Só verificação</Badge></div> : null;
  const change = async (next: boolean) => {
    setSaving(true); setError('');
    try {
      const saved = await json(`/api/numbers/${number.id}/settings`, { method: 'PATCH', body: JSON.stringify({ verificationOnly: next }) });
      setEnabled(Boolean(saved?.verification_only ?? next));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  return <>
    <label className="line-setting">
      <span>Só para verificação de WhatsApp<small>A linha só confere se um telefone tem WhatsApp e não faz ligações.</small></span>
      <input type="checkbox" checked={enabled} disabled={saving} onChange={(event) => void change(event.target.checked)} />
    </label>
    {error && <div className="alert" role="alert"><Icon name="alert" /><span>{error}</span></div>}
  </>;
}

/** Nova camuflagem (#5) na criação: a linha nasce como o celular da Multilogin escolhido. */
function CreateDeviceProfileField({ numberForm, setNumberForm }: { numberForm: AnyRow; setNumberForm: AnyRow['setNumberForm'] }) {
  const [on, setOn] = useState(Boolean(numberForm.multiloginPhoneId));
  const { phones, error } = useMultiloginPhones(on);
  const toggle = (next: boolean) => {
    setOn(next);
    if (!next) { const { multiloginPhoneId: _dropped, ...rest } = numberForm; setNumberForm(rest); }
  };
  return <>
    <label className="line-setting">
      <span>{DEVICE_PROFILE_OPTION_NEW}<small>{DEVICE_PROFILE_CREATE_HINT}</small></span>
      <input type="checkbox" checked={on} onChange={(event) => toggle(event.target.checked)} />
    </label>
    {on && <div className="form-row"><MultiloginPhoneSelect value={numberForm.multiloginPhoneId ?? ''} onChange={(id) => setNumberForm({ ...numberForm, multiloginPhoneId: id || undefined })} phones={phones} /></div>}
    {error && <div className="alert" role="alert"><Icon name="alert" /><span>{error}</span></div>}
  </>;
}

/** Camuflagem de navegador da linha (só o admin do ZapLiga): vale no próximo login; o registro, no próximo QR. */
export function StealthToggle({ number, canManage }: { number: AnyRow; canManage: boolean }) {
  const [line, setLine] = useState<{ enabled: boolean; coverage: string | null }>({ enabled: Boolean(number.stealth_enabled), coverage: number.stealth_coverage ?? null });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!canManage) return null;
  const change = async (next: boolean) => {
    setSaving(true); setError('');
    try {
      const saved = await json(`/api/numbers/${number.id}/stealth`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
      setLine({ enabled: Boolean(saved?.stealth_enabled ?? next), coverage: saved?.stealth_coverage ?? null });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  return <>
    <label className="line-setting">
      <span>{STEALTH_LABEL}<small>{STEALTH_HINT}</small></span>
      <input type="checkbox" checked={line.enabled} disabled={saving} onChange={(event) => void change(event.target.checked)} />
    </label>
    {line.enabled && line.coverage && <div className="resource-meta"><span>Camuflagem</span><Badge tone={line.coverage === 'FULL' ? 'success' : 'warning'}>{STEALTH_COVERAGE_COPY[line.coverage] ?? line.coverage}</Badge></div>}
    {error && <div className="alert" role="alert"><Icon name="alert" /><span>{error}</span></div>}
  </>;
}

/** Código de 8 caracteres para conectar sem QR: WhatsApp → Aparelhos conectados → Conectar com número de telefone. */
export function PairCodeForm({ numberId, defaultPhone = '' }: { numberId: string; defaultPhone?: string }) {
  const [phone, setPhone] = useState(defaultPhone);
  const [pair, setPair] = useState<{ code: string; timeout_seconds: number } | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState('');

  const requestPairCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setPairing(true); setPairError('');
    try { setPair(await json(`/api/numbers/${numberId}/pair`, { method: 'POST', body: JSON.stringify({ phone }) })); }
    catch (error) { setPairError(error instanceof Error ? error.message : String(error)); }
    finally { setPairing(false); }
  };

  return <>
    {pair ? <>
      <div className="pair-code-value" aria-label="Código de conexão">{pair.code.length === 8 ? `${pair.code.slice(0, 4)}-${pair.code.slice(4)}` : pair.code}</div>
      <p>No celular: WhatsApp → Aparelhos conectados → Conectar aparelho → <strong>Conectar com número de telefone</strong>, e digite o código. Vale por {Math.round(pair.timeout_seconds / 60)} min.</p>
      <Button variant="ghost" type="button" onClick={() => setPair(null)}>Gerar outro código</Button>
    </> : <form className="form-row" onSubmit={requestPairCode}>
      <input aria-label="Telefone do WhatsApp" placeholder="Ex.: 5527999999999" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} required />
      <Button disabled={pairing}>{pairing ? 'Gerando...' : 'Gerar código'}</Button>
    </form>}
    {pairError && <div className="alert" role="alert"><Icon name="alert" /><span>{pairError}</span></div>}
  </>;
}

export function PairCodeModal({ number, onClose }: { number: AnyRow; onClose: () => void }) {
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="pair-title" onClick={(e) => e.stopPropagation()}>
      <button className="modal-close" onClick={onClose} aria-label="Fechar modal"><Icon name="close" /></button>
      <div className="modal-icon"><Icon name="phone" size={20} /></div>
      <h2 id="pair-title">Conectar por código</h2>
      <p>Informe o número do WhatsApp (com DDI e DDD) de <strong>{number.label}</strong>. O ZapLiga gera um código de 8 caracteres para digitar no celular, sem escanear QR Code.</p>
      <div className="pair-code"><PairCodeForm numberId={number.id} defaultPhone={number.phone ?? ''} /></div>
    </div>
  </div>;
}

export function QrModal({ qr, closeQr, numberId, defaultPhone = '' }: AnyRow) {
  const payload = Array.isArray(qr.qr_codes) && typeof qr.qr_codes[0] === 'string' ? qr.qr_codes[0] : typeof qr.qr === 'string' ? qr.qr : '';
  const isDataImage = payload.startsWith('data:');
  const isLoggedIn = connectedStatuses.includes(String(qr.status).toLowerCase());
  const isError = qr.status === 'error';

  return <div className="modal-backdrop" onClick={closeQr}>
    <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="qr-title" onClick={(e) => e.stopPropagation()}>
      <button className="modal-close" onClick={closeQr} aria-label="Fechar modal"><Icon name="close" /></button>
      <div className="modal-icon"><Icon name="qr" size={20} /></div>
      <h2 id="qr-title">QR Code da sessão</h2>
      <p>{isLoggedIn ? 'Esta sessão já está conectada ao WhatsApp.' : 'Abra o WhatsApp no celular e escaneie o código para conectar.'}</p>
      {payload && !isDataImage ? <div className="qr-image"><QRCodeSVG value={payload} size={260} bgColor="#ffffff" fgColor="#111827" level="M" /></div>
        : payload && isDataImage ? <div className="qr-image"><img src={payload} alt="QR Code da sessão" /></div>
          : <div className="qr-loading" style={isError ? { color: '#dc2626', padding: 20, textAlign: 'center' } : undefined}>
            {qr.status === 'loading' ? 'Carregando QR Code...'
              : isError ? (qr.error ?? 'Não foi possível carregar o QR Code.')
                : isLoggedIn ? 'Nenhum QR Code é necessário.'
                  : <pre>{JSON.stringify(qr, null, 2)}</pre>}
          </div>}
      <small className="modal-hint">Atualização automática a cada 15s · validade informada: {qr.timeout_seconds ?? '—'}s.</small>
      {numberId && !isLoggedIn && <div className="pair-code">
        <strong>Ou conecte com o número de telefone</strong>
        <PairCodeForm numberId={numberId} defaultPhone={defaultPhone} />
      </div>}
    </div>
  </div>;
}
