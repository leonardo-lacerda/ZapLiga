import { useState } from 'react';
import type React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';
import { Badge, Button, EmptyState, Icon, Pagination, Panel, SectionHeader } from '../../components/ui';
import { PAGE_SIZE, formatNumber, labelStatus } from '../../shared/format';

const connectedStatuses = ['connected', 'online', 'ready', 'authenticated', 'logged_in'];

function updateNumberField(setNumberForm: AnyRow['setNumberForm'], numberForm: AnyRow, field: string, value: string | number) {
  setNumberForm({ ...numberForm, [field]: value });
}

// `canProvision`: flag whatsapp_provisioning + papel leader/super_admin (calculado em App com canUseProvisioning).
export function NumbersPage({ numbers, numbersTotal, numbersOffset, onNumbersPageChange, numberForm, setNumberForm, createNumber, showQr, reconnectNumber, removeNumber, qrLoading, qr, qrNumberId, closeQr, canManageNumbers = false, canProvision = false, onOpenProvisioning, canaryCall, stationReady = false }: AnyRow) {
  const [pairNumber, setPairNumber] = useState<AnyRow | null>(null);
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">WHATSAPP</span><h1>Números</h1><p>{canManageNumbers ? 'Gerencie as sessões conectadas à sua operação.' : 'Consulte as sessões conectadas à sua operação.'}</p></div>
      <div className="page-heading-actions">
        {canProvision && <Button variant="secondary" icon="plus" onClick={() => onOpenProvisioning?.()}>Cadastrar número no GeeLark</Button>}
        <Badge tone="info">{formatNumber(numbersTotal)} sessões</Badge>
      </div>
    </div>
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

        <div className="number-form-footer">
          <p className="form-hint">A linha nasce com os limites de <strong>Configurações do discador</strong> (chamadas simultâneas e proteção entre chamadas). Depois de criar, conecte pelo card da sessão: <strong>Abrir QR</strong> (escanear com o celular) ou <strong>Conectar por código</strong> (digitar um código no WhatsApp do celular).</p>
          <Button icon="plus">Criar sessão</Button>
        </div>
      </form>
    </Panel>}
    <div className="resource-grid">
      {numbers.map((number: AnyRow) => <div className="resource-card" key={number.id}>
        <div className="resource-card-header"><div className="resource-icon blue"><Icon name="phone" size={18} /></div><Badge tone={connectedStatuses.includes(String(number.status).toLowerCase()) ? 'success' : 'neutral'}>{labelStatus(number.status)}</Badge></div>
        <h3>{number.label}</h3><p>{number.phone || 'Telefone não informado'}</p>
        <div className="resource-meta"><span>Limite de chamadas</span><strong>{number.max_concurrent_calls}</strong></div>
        <div className="resource-meta"><span>Cadência protegida</span><strong>{number.max_calls_per_window ?? 3} / {number.call_window_seconds ?? 180}s</strong></div>
        <CallBlock flaggedUntil={number.flagged_until} />
        <LineHealth number={number} />
        {canManageNumbers && <CanaryStep number={number} canaryCall={canaryCall} stationReady={stationReady} />}
        <VerificationOnlyToggle number={number} canManage={canManageNumbers} />
        {canManageNumbers && <div className="card-actions">{!connectedStatuses.includes(String(number.status).toLowerCase()) && <><Button variant="secondary" icon="qr" disabled={qrLoading} onClick={() => void showQr(number.id)}>Abrir QR</Button><Button variant="secondary" icon="phone" disabled={qrLoading} onClick={() => setPairNumber(number)}>Conectar por código</Button></>}<Button variant="ghost" icon="refresh" disabled={qrLoading} onClick={() => void reconnectNumber(number.id)}>Reconectar</Button><Button variant="danger" icon="close" disabled={qrLoading} onClick={() => void removeNumber(number.id, number.label)}>Remover</Button></div>}
      </div>)}
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
  return <div className="resource-meta"><span>Ligações</span><Badge tone="warning">Bloqueadas até {until}</Badge></div>;
}

const RETIRED_AFTER_LOSSES = 2;
const YOUNG_LINE_DAILY_CALLS = 40;
const lossCopy: Record<string, string> = {
  device_removed: 'Removida pelo WhatsApp: precisa de QR novo e descanso',
  account_locked: 'Conta travada: resolva no celular antes do QR',
};

// Por que a linha caiu, quantas ligações ela fez hoje (limite da linha jovem) e quantas vezes reconectou.
function LineHealth({ number }: { number: AnyRow }) {
  const retired = Number(number.removal_count ?? 0) >= RETIRED_AFTER_LOSSES;
  return <>
    {retired && <div className="resource-meta"><span>Linha</span><Badge tone="error">Aposentada: o WhatsApp tirou este número {number.removal_count} vezes</Badge></div>}
    {!retired && number.loss_reason && <div className="resource-meta"><span>Queda</span><Badge tone="error">{lossCopy[number.loss_reason] ?? number.loss_reason}</Badge></div>}
    {number.young && <div className="resource-meta"><span>Ligações hoje</span><strong>{number.calls_today ?? 0}/{YOUNG_LINE_DAILY_CALLS}</strong></div>}
    {Number(number.reconnects_24h ?? 0) > 0 && <div className="resource-meta"><span>Reconexões em 24 h</span><strong>{number.reconnects_24h}</strong></div>}
  </>;
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
  if (number.canary_status === 'passed' || number.loss_reason || Number(number.removal_count ?? 0) >= RETIRED_AFTER_LOSSES) return null;
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
  return <div className="admin-flag-row">
    <span>{number.canary_status === 'failed' ? 'Canário reprovado: tente de novo depois do descanso' : 'Aguardando canário'}<small>A primeira ligação depois do QR vai para o celular de alguém da equipe, nunca para um lead. Só depois a linha liga para leads.</small></span>
    {connected && !blocked && <div className="card-actions">
      {!phone && <Button variant="secondary" icon="note" disabled={busy} onClick={() => void sendMessage()}>1. Enviar mensagem</Button>}
      {phone && <><small>Mensagem enviada para {phone}. Peça para a pessoa responder, ligue, converse uns 30 segundos e desligue.</small><Button variant="secondary" icon="phone" disabled={busy || !stationReady} onClick={() => void call()}>2. Ligar para {phone}</Button></>}
      {phone && !stationReady && <small>Conecte sua estação de ligação para ligar.</small>}
    </div>}
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
    <label className="admin-flag-row">
      <span>Só para verificação de WhatsApp<small>A linha só confere se um telefone tem WhatsApp e não faz ligações.</small></span>
      <input type="checkbox" checked={enabled} disabled={saving} onChange={(event) => void change(event.target.checked)} />
    </label>
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
