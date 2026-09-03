import { QRCodeSVG } from 'qrcode.react';
import type { AnyRow } from '../../types';
import { Badge, Button, EmptyState, Icon, Pagination, Panel, SectionHeader } from '../../components/ui';
import { PAGE_SIZE, formatNumber, labelStatus } from '../../shared/format';

const connectedStatuses = ['connected', 'online', 'ready', 'authenticated', 'logged_in'];

export function NumbersPage({ numbers, numbersTotal, numbersOffset, onNumbersPageChange, numberForm, setNumberForm, createNumber, showQr, reconnectNumber, removeNumber, qrLoading, qr, closeQr, canManageNumbers = false }: AnyRow) {
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">WHATSAPP</span><h1>Numeros</h1><p>{canManageNumbers ? 'Gerencie as sessoes conectadas a sua operacao.' : 'Consulte as sessoes conectadas a sua operacao.'}</p></div>
      <Badge tone="info">{formatNumber(numbersTotal)} sessoes</Badge>
    </div>
    {canManageNumbers && <Panel>
      <SectionHeader title="Adicionar numero" description="Crie uma sessao para conectar um numero autorizado." />
      <form className="form-row" onSubmit={createNumber}>
        <input placeholder="Nome do numero" value={numberForm.label} onChange={(e) => setNumberForm({ ...numberForm, label: e.target.value })} required />
        <input placeholder="Telefone opcional" value={numberForm.phone} onChange={(e) => setNumberForm({ ...numberForm, phone: e.target.value })} />
        <input aria-label="Chamadas simultaneas por linha" placeholder="Simultaneas" type="number" min="1" max="50" value={numberForm.maxConcurrentCalls ?? 1} onChange={(e) => setNumberForm({ ...numberForm, maxConcurrentCalls: Number(e.target.value) })} title="Limite simultaneo da linha" />
        <input aria-label="Cooldown entre chamadas" placeholder="Cooldown (s)" type="number" min="0" max="3600" value={numberForm.cooldownSeconds ?? 60} onChange={(e) => setNumberForm({ ...numberForm, cooldownSeconds: Number(e.target.value) })} title="Segundos entre chamadas" />
        <input aria-label="Limite de chamadas na janela" placeholder="Tentativas" type="number" min="1" max="20" value={numberForm.maxCallsPerWindow ?? 3} onChange={(e) => setNumberForm({ ...numberForm, maxCallsPerWindow: Number(e.target.value) })} title="Tentativas permitidas por janela" />
        <input aria-label="Janela de chamadas em segundos" placeholder="Janela (s)" type="number" min="60" max="3600" value={numberForm.callWindowSeconds ?? 180} onChange={(e) => setNumberForm({ ...numberForm, callWindowSeconds: Number(e.target.value) })} title="Janela móvel em segundos" />
        <Button icon="plus">Criar sessao</Button>
      </form>
    </Panel>}
    <div className="resource-grid">
      {numbers.map((number: AnyRow) => <div className="resource-card" key={number.id}>
        <div className="resource-card-header"><div className="resource-icon blue"><Icon name="phone" size={18} /></div><Badge tone={connectedStatuses.includes(String(number.status).toLowerCase()) ? 'success' : 'neutral'}>{labelStatus(number.status)}</Badge></div>
        <h3>{number.label}</h3><p>{number.phone || 'Telefone nao informado'}</p>
        <div className="resource-meta"><span>Limite de chamadas</span><strong>{number.max_concurrent_calls}</strong></div>
        <div className="resource-meta"><span>Cadência protegida</span><strong>{number.max_calls_per_window ?? 3} / {number.call_window_seconds ?? 180}s</strong></div>
        {canManageNumbers && <div className="card-actions">{!connectedStatuses.includes(String(number.status).toLowerCase()) && <Button variant="secondary" icon="qr" disabled={qrLoading} onClick={() => void showQr(number.id)}>Abrir QR</Button>}<Button variant="ghost" icon="refresh" disabled={qrLoading} onClick={() => void reconnectNumber(number.id)}>Reconectar</Button><Button variant="danger" icon="close" disabled={qrLoading} onClick={() => void removeNumber(number.id, number.label)}>Remover</Button></div>}
      </div>)}
      {!numbers.length && <div className="full-span"><EmptyState title="Nenhum numero cadastrado" description={canManageNumbers ? 'Adicione uma sessao para conectar seu WhatsApp.' : 'Os numeros serao configurados pelo administrador da plataforma.'} /></div>}
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
      <h2 id="qr-title">QR Code da sessao</h2>
      <p>{isLoggedIn ? 'Esta sessao ja esta conectada ao WhatsApp.' : 'Abra o WhatsApp no celular e escaneie o codigo para conectar.'}</p>
      {payload && !isDataImage ? <div className="qr-image"><QRCodeSVG value={payload} size={260} bgColor="#ffffff" fgColor="#111827" level="M" /></div>
        : payload && isDataImage ? <div className="qr-image"><img src={payload} alt="QR Code da sessao" /></div>
          : <div className="qr-loading" style={isError ? { color: '#dc2626', padding: 20, textAlign: 'center' } : undefined}>
            {qr.status === 'loading' ? 'Carregando QR Code...'
              : isError ? (qr.error ?? 'Nao foi possivel carregar o QR Code.')
                : isLoggedIn ? 'Nenhum QR Code e necessario.'
                  : <pre>{JSON.stringify(qr, null, 2)}</pre>}
          </div>}
      <small className="modal-hint">Atualizacao automatica a cada 15s · validade informada: {qr.timeout_seconds ?? '—'}s.</small>
    </div>
  </div>;
}
