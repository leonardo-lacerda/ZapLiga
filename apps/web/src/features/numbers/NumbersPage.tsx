import { QRCodeSVG } from 'qrcode.react';
import type { AnyRow } from '../../types';
import { Badge, Button, EmptyState, Icon, Pagination, Panel, SectionHeader } from '../../components/ui';
import { PAGE_SIZE, formatNumber, labelStatus } from '../../shared/format';

const connectedStatuses = ['connected', 'online', 'ready', 'authenticated', 'logged_in'];

function updateNumberField(setNumberForm: AnyRow['setNumberForm'], numberForm: AnyRow, field: string, value: string | number) {
  setNumberForm({ ...numberForm, [field]: value });
}

export function NumbersPage({ numbers, numbersTotal, numbersOffset, onNumbersPageChange, numberForm, setNumberForm, createNumber, showQr, reconnectNumber, removeNumber, qrLoading, qr, closeQr, canManageNumbers = false }: AnyRow) {
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">WHATSAPP</span><h1>Números</h1><p>{canManageNumbers ? 'Gerencie as sessões conectadas à sua operação.' : 'Consulte as sessões conectadas à sua operação.'}</p></div>
      <Badge tone="info">{formatNumber(numbersTotal)} sessões</Badge>
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

        <div className="number-form-section">
          <div className="number-form-section-head">
            <strong>Proteção da linha</strong>
            <span>Limites que evitam spam e bloqueio no WhatsApp. Os valores padrão já são seguros para começar.</span>
          </div>
          <div className="number-form-grid number-form-grid-limits">
            <label>
              <span>Chamadas simultâneas</span>
              <input
                name="maxConcurrentCalls"
                type="number"
                min={1}
                max={50}
                value={numberForm.maxConcurrentCalls ?? 1}
                onChange={(e) => updateNumberField(setNumberForm, numberForm, 'maxConcurrentCalls', Number(e.target.value))}
                required
              />
              <small>Quantas chamadas esta linha pode manter ao mesmo tempo (1–50). Padrão: 1.</small>
            </label>
            <label>
              <span>Espera entre chamadas (segundos)</span>
              <input
                name="cooldownSeconds"
                type="number"
                min={0}
                max={3600}
                value={numberForm.cooldownSeconds ?? 60}
                onChange={(e) => updateNumberField(setNumberForm, numberForm, 'cooldownSeconds', Number(e.target.value))}
                required
              />
              <small>Pausa mínima após cada chamada antes de discar de novo (0–3600). Padrão: 60.</small>
            </label>
            <label>
              <span>Tentativas na janela</span>
              <input
                name="maxCallsPerWindow"
                type="number"
                min={1}
                max={20}
                value={numberForm.maxCallsPerWindow ?? 3}
                onChange={(e) => updateNumberField(setNumberForm, numberForm, 'maxCallsPerWindow', Number(e.target.value))}
                required
              />
              <small>Máximo de tentativas nesta linha dentro da janela móvel (1–20). Padrão: 3.</small>
            </label>
            <label>
              <span>Janela de proteção (segundos)</span>
              <input
                name="callWindowSeconds"
                type="number"
                min={60}
                max={3600}
                value={numberForm.callWindowSeconds ?? 180}
                onChange={(e) => updateNumberField(setNumberForm, numberForm, 'callWindowSeconds', Number(e.target.value))}
                required
              />
              <small>Duração da janela móvel usada com as tentativas acima (60–3600). Padrão: 180.</small>
            </label>
          </div>
        </div>

        <div className="number-form-footer">
          <p className="form-hint">Depois de criar, use <strong>Abrir QR</strong> no card da sessão para conectar o WhatsApp no celular.</p>
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
    {qr && <QrModal qr={qr} closeQr={closeQr} />}
  </>;
}

export function QrModal({ qr, closeQr }: AnyRow) {
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
    </div>
  </div>;
}
