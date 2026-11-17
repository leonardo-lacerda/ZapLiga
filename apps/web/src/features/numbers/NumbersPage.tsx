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
export function NumbersPage({ numbers, numbersTotal, numbersOffset, onNumbersPageChange, numberForm, setNumberForm, createNumber, showQr, reconnectNumber, removeNumber, qrLoading, qr, qrNumberId, closeQr, canManageNumbers = false, canProvision = false, onOpenProvisioning }: AnyRow) {
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">WHATSAPP</span><h1>Números</h1><p>{canManageNumbers ? 'Gerencie as sessões conectadas à sua operação.' : 'Consulte as sessões conectadas à sua operação.'}</p></div>
      <div className="page-heading-actions">
        {canProvision && <Button variant="secondary" icon="plus" onClick={() => onOpenProvisioning?.()}>Cadastrar número no GeeLark</Button>}
        <Badge tone="info">{formatNumber(numbersTotal)} sessões</Badge>
      </div>
    </div>
    {canManageNumbers && <Panel>
      <SectionHeader title="Adicionar número" description="Crie uma sessão e escaneie o QR Code para conectar um WhatsApp autorizado." />
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
          <p className="form-hint">A linha nasce com os limites de <strong>Configurações do discador</strong> (chamadas simultâneas e proteção entre chamadas). Depois de criar, use <strong>Abrir QR</strong> no card da sessão para conectar o WhatsApp no celular.</p>
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
        {canManageNumbers && <div className="card-actions">{!connectedStatuses.includes(String(number.status).toLowerCase()) && <Button variant="secondary" icon="qr" disabled={qrLoading} onClick={() => void showQr(number.id)}>Abrir QR</Button>}<Button variant="ghost" icon="refresh" disabled={qrLoading} onClick={() => void reconnectNumber(number.id)}>Reconectar</Button><Button variant="danger" icon="close" disabled={qrLoading} onClick={() => void removeNumber(number.id, number.label)}>Remover</Button></div>}
      </div>)}
      {!numbers.length && <div className="full-span"><EmptyState title="Nenhum número cadastrado" description={canManageNumbers ? 'Adicione uma sessão para conectar seu WhatsApp.' : 'Os números serão configurados pelo administrador da plataforma.'} /></div>}
    </div>
    <Pagination offset={numbersOffset} limit={PAGE_SIZE} total={numbersTotal} onChange={onNumbersPageChange} />
    {qr && <QrModal qr={qr} closeQr={closeQr} numberId={qrNumberId} defaultPhone={numbers.find((number: AnyRow) => number.id === qrNumberId)?.phone ?? ''} />}
  </>;
}

export function QrModal({ qr, closeQr, numberId, defaultPhone = '' }: AnyRow) {
  const [phone, setPhone] = useState(defaultPhone);
  const [pair, setPair] = useState<{ code: string; timeout_seconds: number } | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState('');
  const payload = Array.isArray(qr.qr_codes) && typeof qr.qr_codes[0] === 'string' ? qr.qr_codes[0] : typeof qr.qr === 'string' ? qr.qr : '';
  const isDataImage = payload.startsWith('data:');
  const isLoggedIn = connectedStatuses.includes(String(qr.status).toLowerCase());
  const isError = qr.status === 'error';

  const requestPairCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setPairing(true); setPairError('');
    try { setPair(await json(`/api/numbers/${numberId}/pair`, { method: 'POST', body: JSON.stringify({ phone }) })); }
    catch (error) { setPairError(error instanceof Error ? error.message : String(error)); }
    finally { setPairing(false); }
  };

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
        {pair ? <>
          <div className="pair-code-value" aria-label="Código de conexão">{pair.code.length === 8 ? `${pair.code.slice(0, 4)}-${pair.code.slice(4)}` : pair.code}</div>
          <p>No celular: WhatsApp → Aparelhos conectados → Conectar aparelho → <strong>Conectar com número de telefone</strong>, e digite o código. Vale por {Math.round(pair.timeout_seconds / 60)} min.</p>
          <Button variant="ghost" type="button" onClick={() => setPair(null)}>Gerar outro código</Button>
        </> : <form className="form-row" onSubmit={requestPairCode}>
          <input aria-label="Telefone do WhatsApp" placeholder="Ex.: 5527999999999" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} required />
          <Button disabled={pairing}>{pairing ? 'Gerando...' : 'Gerar código'}</Button>
        </form>}
        {pairError && <div className="alert" role="alert"><Icon name="alert" /><span>{pairError}</span></div>}
      </div>}
    </div>
  </div>;
}
