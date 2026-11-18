import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { fetchPhones, stopPhone } from './provisioning.api';
import type { Phone } from './provisioning.types';

/** GeeLark cobra por minuto ligado (plano Base: US$ 0,007/min, depois dos minutos grátis). */
export const PRICE_PER_MINUTE_USD = 0.007;
export const PHONES_REFRESH_MS = 15_000;

const isOn = (phone: Phone) => phone.status === 'on' || phone.status === 'starting';
const statusBadge: Record<string, { label: string; tone: string }> = {
  on: { label: 'Ligado · cobrando', tone: 'warning' },
  starting: { label: 'Ligando · cobrando', tone: 'warning' },
  off: { label: 'Desligado', tone: 'neutral' },
  expired: { label: 'Expirado', tone: 'error' },
  unknown: { label: 'Desconhecido', tone: 'neutral' },
};
const usd = (value: number) => `US$ ${value.toFixed(2).replace('.', ',')}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Props = { tenantId: string; refreshMs?: number };

/** Quem está ligado no GeeLark agora, quanto isso custa por hora, e o botão de desligar. */
export function PhonesPanel({ tenantId, refreshMs = PHONES_REFRESH_MS }: Props) {
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string[]>([]);

  const load = useCallback(async () => {
    try { setPhones(await fetchPhones(tenantId)); setError(''); }
    catch (e) { setError(errorText(e)); }
  }, [tenantId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => window.clearInterval(timer);
  }, [load, refreshMs]);

  const powerOff = async (targets: Phone[]) => {
    if (!targets.length) return;
    const inUse = targets.filter((phone) => phone.busyJobId);
    const question = inUse.length
      ? `${inUse.map((phone) => phone.name).join(', ')} está no meio de um cadastro, que será cancelado. Desligar mesmo assim?`
      : targets.length > 1 ? `Desligar ${targets.length} telefones?` : `Desligar ${targets[0].name}?`;
    if (!window.confirm(question)) return;
    setBusy((current) => [...current, ...targets.map((phone) => phone.id)]);
    setError('');
    for (const phone of targets) {
      try {
        const updated = await stopPhone(tenantId, phone.id);
        setPhones((current) => current?.map((item) => (item.id === phone.id ? { ...item, ...updated } : item)) ?? current);
      } catch (e) { setError(`${phone.name}: ${errorText(e)}`); }
    }
    setBusy((current) => current.filter((id) => !targets.some((phone) => phone.id === id)));
    void load();
  };

  const on = phones?.filter(isOn) ?? [];
  const perHour = on.length * PRICE_PER_MINUTE_USD * 60;

  return <Panel className="provisioning-phones">
    <SectionHeader
      title="Telefones no GeeLark"
      description="Telefone ligado é cobrado por minuto. Atualiza sozinho a cada 15 segundos."
      action={<div className="provisioning-inline-actions">
        {on.length > 1 && <Button variant="danger" icon="close" onClick={() => void powerOff(on)} disabled={busy.length > 0}>Desligar todos</Button>}
        <Button variant="ghost" icon="refresh" onClick={() => void load()}>Atualizar</Button>
      </div>}
    />
    {phones && <div className={`alert ${on.length ? 'alert-warning' : ''} provisioning-phones-summary`} role="status">
      <Icon name={on.length ? 'alert' : 'check'} size={17} />
      <span>{on.length
        ? <><strong>{on.length} {on.length === 1 ? 'telefone ligado' : 'telefones ligados'}</strong> · cerca de {usd(perHour)} por hora enquanto continuarem assim.</>
        : <>Nenhum telefone ligado: nada sendo cobrado agora.</>}</span>
    </div>}
    {error && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{error}</span></div>}
    {phones === null && !error && <p className="subtle">Carregando os telefones…</p>}
    {phones && phones.length > 0 && <ul className="provisioning-phones-list">
      {phones.map((phone) => {
        const badge = statusBadge[phone.status] ?? statusBadge.unknown;
        const stopping = busy.includes(phone.id);
        return <li key={phone.id}>
          <div>
            <strong>{phone.name}</strong>
            <small>{phone.android} · Rede: {phone.proxy || 'sem proxy'}{phone.busyJobId ? ' · em cadastro agora' : ''}</small>
          </div>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {isOn(phone)
            ? <Button variant="secondary" icon="close" onClick={() => void powerOff([phone])} disabled={stopping} aria-label={`Desligar ${phone.name}`}>{stopping ? 'Desligando…' : 'Desligar'}</Button>
            : <span className="provisioning-phones-spacer" />}
        </li>;
      })}
    </ul>}
    {phones && !phones.length && <p className="subtle">Nenhum telefone no GeeLark ainda.</p>}
  </Panel>;
}
