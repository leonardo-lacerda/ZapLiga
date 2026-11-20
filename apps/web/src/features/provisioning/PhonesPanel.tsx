import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { createJob, deletePhone, fetchEgressNodes, fetchPhones, newDevicePhone, renamePhone, stopPhone } from './provisioning.api';
import type { EgressNode, Phone } from './provisioning.types';
import { useDialog } from './useDialog';

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
const pcName = (node: EgressNode) => node.pcName && node.pcName !== node.label ? `${node.label} (${node.pcName})` : node.label;

type Busy = Record<string, string>;   // phoneId -> o que está acontecendo ("Desligando…")
type Props = { tenantId: string; refreshMs?: number; onOpenJob?: (jobId: string) => void };

/**
 * Os telefones do GeeLark, geridos daqui: quem está ligado (e quanto custa), abrir o telefone
 * com a tela ao vivo, desligar, renomear, gerar um aparelho novo e apagar.
 */
export function PhonesPanel({ tenantId, refreshMs = PHONES_REFRESH_MS, onOpenJob }: Props) {
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [nodes, setNodes] = useState<EgressNode[]>([]);
  const [pc, setPc] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Busy>({});
  const [dialog, ask] = useDialog();

  const load = useCallback(async () => {
    try { setPhones(await fetchPhones(tenantId)); setError(''); }
    catch (e) { setError(errorText(e)); }
    try { setNodes((await fetchEgressNodes(tenantId)).items); } catch { /* sem PCs: "Abrir" fica indisponível */ }
  }, [tenantId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => window.clearInterval(timer);
  }, [load, refreshMs]);

  const online = useMemo(() => nodes.filter((node) => node.online), [nodes]);
  // PC padrão para abrir um telefone: o meu, se estiver online; senão o primeiro online.
  useEffect(() => {
    if (online.some((node) => node.node === pc)) return;
    setPc((online.find((node) => node.isMine) ?? online[0])?.node ?? '');
  }, [online, pc]);

  const track = (ids: string[], label: string | null) => setBusy((current) => {
    const next = { ...current };
    for (const id of ids) { if (label) next[id] = label; else delete next[id]; }
    return next;
  });
  const patch = (id: string, changes: Partial<Phone>) =>
    setPhones((current) => current?.map((item) => (item.id === id ? { ...item, ...changes } : item)) ?? current);

  const act = async (phone: Phone, label: string, action: () => Promise<void>) => {
    track([phone.id], label);
    setError('');
    try { await action(); } catch (e) { setError(`${phone.name}: ${errorText(e)}`); }
    track([phone.id], null);
    void load();
  };

  const powerOff = async (targets: Phone[]) => {
    if (!targets.length) return;
    const inUse = targets.filter((phone) => phone.busyJobId);
    const body = inUse.length
      ? `${inUse.map((phone) => phone.name).join(', ')} está no meio de um cadastro ou sessão, que será encerrado.`
      : 'O telefone para de cobrar assim que desligar.';
    const title = targets.length > 1 ? `Desligar ${targets.length} telefones?` : `Desligar ${targets[0].name}?`;
    if (!(await ask({ title, body, confirmLabel: 'Desligar', danger: inUse.length > 0 }))) return;
    track(targets.map((phone) => phone.id), 'Desligando…');
    setError('');
    for (const phone of targets) {
      try { patch(phone.id, await stopPhone(tenantId, phone.id)); }
      catch (e) { setError(`${phone.name}: ${errorText(e)}`); }
    }
    track(targets.map((phone) => phone.id), null);
    void load();
  };

  const open = (phone: Phone) => act(phone, 'Abrindo…', async () => {
    const job = await createJob(tenantId, { egressNode: pc, geelarkPhoneId: phone.id, mode: 'control' });
    onOpenJob?.(job.id);
  });

  const rename = async (phone: Phone) => {
    const answer = await ask({ title: `Renomear ${phone.name}`, body: 'O nome aparece aqui e no GeeLark.', confirmLabel: 'Renomear',
      input: { label: 'Novo nome', initial: phone.name } });
    const name = typeof answer === 'string' ? answer : '';
    if (!name || name === phone.name) return;
    void act(phone, 'Renomeando…', async () => { patch(phone.id, await renamePhone(tenantId, phone.id, name)); });
  };

  const newDevice = async (phone: Phone) => {
    if (!(await ask({ title: `Gerar um aparelho novo para ${phone.name}?`, confirmLabel: 'Gerar aparelho novo', danger: true,
      body: 'O GeeLark troca a marca, o modelo e o número do SIM, como um celular novo. O WhatsApp que estiver nele é apagado; '
        + 'se esse número estiver conectado ao ZapLiga, a linha cai. O telefone é desligado antes.' }))) return;
    void act(phone, 'Gerando aparelho novo…', async () => { patch(phone.id, await newDevicePhone(tenantId, phone.id)); });
  };

  const remove = async (phone: Phone) => {
    const typed = await ask({ title: `Apagar ${phone.name} de vez?`, confirmLabel: 'Apagar de vez', danger: true,
      body: 'Não dá para desfazer, e o WhatsApp que estiver nele perde o aparelho principal.',
      input: { label: `Para confirmar, digite ${phone.name}`, mustEqual: phone.name } });
    if (typed !== phone.name) return;
    void act(phone, 'Apagando…', async () => {
      await deletePhone(tenantId, phone.id);
      setPhones((current) => current?.filter((item) => item.id !== phone.id) ?? current);
    });
  };

  const on = phones?.filter(isOn) ?? [];
  const perHour = on.length * PRICE_PER_MINUTE_USD * 60;
  const anyBusy = Object.keys(busy).length > 0;

  return <Panel className="provisioning-phones">
    {dialog}
    <SectionHeader
      title="Telefones no GeeLark"
      description="Abra, desligue, renomeie, gere um aparelho novo ou apague, sem sair do ZapLiga. Telefone ligado é cobrado por minuto; a lista atualiza a cada 15 segundos."
      action={<div className="provisioning-inline-actions">
        {on.length > 1 && <Button variant="danger" icon="close" onClick={() => void powerOff(on)} disabled={anyBusy}>Desligar todos</Button>}
        <Button variant="ghost" icon="refresh" onClick={() => void load()}>Atualizar</Button>
      </div>}
    />
    {phones && <div className={`alert ${on.length ? 'alert-warning' : ''} provisioning-phones-summary`} role="status">
      <Icon name={on.length ? 'alert' : 'check'} size={17} />
      <span>{on.length
        ? <><strong>{on.length} {on.length === 1 ? 'telefone ligado' : 'telefones ligados'}</strong> · cerca de {usd(perHour)} por hora enquanto continuarem assim.</>
        : <>Nenhum telefone ligado: nada sendo cobrado agora.</>}</span>
    </div>}
    {phones && phones.length > 0 && <div className="provisioning-phones-pc">
      {online.length
        ? <label className="field"><span>Abrir pelo PC</span>
          <select value={pc} onChange={(event) => setPc(event.target.value)}>
            {online.map((node) => <option key={node.node} value={node.node}>{pcName(node)}{node.isMine ? ' · meu' : ''}</option>)}
          </select>
        </label>
        : <p className="form-hint"><Icon name="info" size={14} /> Nenhum PC online: ligue um PC para abrir os telefones (o telefone só sai pela internet de um PC).</p>}
    </div>}
    {error && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{error}</span></div>}
    {phones === null && !error && <p className="subtle">Carregando os telefones…</p>}
    {phones && phones.length > 0 && <ul className="provisioning-phones-list">
      {phones.map((phone) => {
        const badge = statusBadge[phone.status] ?? statusBadge.unknown;
        const working = busy[phone.id];
        const locked = Boolean(working) || Boolean(phone.busyJobId);
        return <li key={phone.id}>
          <div>
            <strong>{phone.name}</strong>
            <small>{phone.android} · Rede: {phone.proxy || 'sem proxy'}{phone.busyJobId ? ' · em uso agora' : ''}</small>
          </div>
          <Badge tone={badge.tone}>{working ?? badge.label}</Badge>
          <div className="provisioning-phone-actions">
            {phone.busyJobId && onOpenJob && <Button variant="secondary" icon="play" onClick={() => onOpenJob(phone.busyJobId!)} aria-label={`Acompanhar ${phone.name}`}>Acompanhar</Button>}
            {isOn(phone)
              ? <Button variant="secondary" icon="close" onClick={() => void powerOff([phone])} disabled={Boolean(working)} aria-label={`Desligar ${phone.name}`}>Desligar</Button>
              : phone.status === 'off' && <Button icon="play" onClick={() => void open(phone)} disabled={locked || !pc} title={pc ? undefined : 'Nenhum PC online'} aria-label={`Abrir ${phone.name}`}>Abrir</Button>}
            <Button variant="ghost" icon="note" onClick={() => void rename(phone)} disabled={Boolean(working)} aria-label={`Renomear ${phone.name}`}>Renomear</Button>
            <Button variant="ghost" icon="refresh" onClick={() => void newDevice(phone)} disabled={locked || phone.status === 'expired'} aria-label={`Gerar aparelho novo para ${phone.name}`}>Aparelho novo</Button>
            <Button variant="ghost" icon="trash" onClick={() => void remove(phone)} disabled={locked} aria-label={`Apagar ${phone.name}`}>Apagar</Button>
          </div>
        </li>;
      })}
    </ul>}
    {phones && !phones.length && <p className="subtle">Nenhum telefone no GeeLark ainda. Crie um no passo "Telefone" do cadastro acima.</p>}
  </Panel>;
}
