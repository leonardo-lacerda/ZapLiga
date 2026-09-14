import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

type Props = { tenantId: string };
type Interval = 'month' | 'year';

const int = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
const money = (cents: unknown, currency = 'brl') => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: String(currency).toUpperCase() }).format(int(cents) / 100);
const date = (value: unknown) => value ? new Date(String(value)).toLocaleDateString('pt-BR') : '—';
const idempotency = (prefix: string, tenantId: string) => `${prefix}:${tenantId}:${Date.now()}`;

const statusLabels: Record<string, string> = {
  active: 'Ativa', trialing: 'Em avaliação', past_due: 'Pagamento pendente', unpaid: 'Não paga', canceled: 'Cancelada',
  incomplete: 'Pagamento incompleto', no_subscription: 'Sem assinatura', subscription_expired: 'Expirada',
};

const planPrice = (plan: AnyRow, interval: Interval) => (Array.isArray(plan.prices) ? plan.prices : []).find((price: AnyRow) => String(price.interval) === interval) ?? null;
const seatPrice = (plans: AnyRow[], interval: Interval) => plans.flatMap((plan) => Array.isArray(plan.seat_prices) ? plan.seat_prices : []).find((price: AnyRow) => String(price.interval) === interval) ?? null;

export function AdminBillingPanel({ tenantId }: Props) {
  const [billing, setBilling] = useState<AnyRow | null>(null);
  const [plans, setPlans] = useState<AnyRow[]>([]);
  const [planCode, setPlanCode] = useState('');
  const [interval, setInterval] = useState<Interval>('month');
  const [seats, setSeats] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');
  const [checkoutUrl, setCheckoutUrl] = useState('');

  const load = async () => {
    setBusy('load'); setMessage('');
    try {
      const [nextBilling, nextPlans] = await Promise.all([
        json(`/api/admin/tenants/${tenantId}/billing`),
        json(`/api/admin/tenants/${tenantId}/billing/plans`),
      ]);
      const catalog = Array.isArray(nextPlans) ? nextPlans : [];
      const activeCode = String(nextBilling?.planCode ?? '');
      const selected = catalog.find((plan: AnyRow) => String(plan.code) === activeCode) ?? catalog[0];
      const activeInterval: Interval = String(nextBilling?.subscription?.billing_interval) === 'year' ? 'year' : 'month';
      const included = int(selected?.included_sdrs, 1);
      setBilling(nextBilling); setPlans(catalog);
      setPlanCode(String(selected?.code ?? ''));
      setInterval(activeCode ? activeInterval : 'month');
      setSeats(Math.max(included, int(nextBilling?.totalSdrSeats ?? nextBilling?.maxSdrs, included)));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  useEffect(() => { void load(); }, [tenantId]);

  const selectedPlan = useMemo(() => plans.find((plan) => String(plan.code) === planCode) ?? null, [plans, planCode]);
  const included = int(selectedPlan?.included_sdrs, 1);
  const max = Math.max(included, int(selectedPlan?.max_sdrs, included));
  const base = planPrice(selectedPlan ?? {}, interval);
  const addon = seatPrice(plans, interval);
  const extra = Math.max(0, seats - included);
  const total = int(base?.amount) + extra * int(addon?.amount);
  const active = Boolean(billing?.subscription && ['active', 'trialing', 'past_due', 'unpaid'].includes(String(billing.subscription.status)) && billing?.planCode);
  const samePlan = active && String(billing?.planCode) === planCode;
  const used = int(billing?.usedSdrSeats ?? billing?.tenant?.sdr_count);
  const reserved = int(billing?.reservedSdrSeats);
  const lockedFloor = Math.max(included, used + reserved);
  const status = String(billing?.subscription?.status ?? billing?.reason ?? 'no_subscription');

  const requireReason = () => {
    if (reason.trim()) return true;
    setMessage('Informe o motivo administrativo da alteração.');
    return false;
  };

  const run = async (key: string, action: () => Promise<any>, done: string) => {
    setBusy(key); setMessage(''); setSuccess('');
    try { const result = await action(); setSuccess(done); await load(); return result; }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); return null; }
    finally { setBusy(''); }
  };

  const apply = async () => {
    if (!selectedPlan || !requireReason()) return;
    if (seats < lockedFloor) { setMessage(`A organização já utiliza ${lockedFloor} SDRs entre ativos e convites pendentes.`); return; }
    const preview = await run('preview', () => json(`/api/admin/tenants/${tenantId}/billing/preview`, { method: 'POST', body: JSON.stringify({ planCode, interval, totalSdrSeats: seats }) }), '');
    if (!preview) return;
    const amount = int(preview.price?.amount ?? total);
    const effective = preview.effectiveAt === 'period_end' ? ` no fim do ciclo (${date(preview.currentPeriodEnd)})` : preview.effectiveAt === 'after_payment' ? ' após a confirmação do pagamento' : ' imediatamente';
    if (!window.confirm(`Aplicar ${selectedPlan.display_name ?? planCode} com ${seats} SDRs por ${money(amount, preview.price?.currency ?? base?.currency)}${effective}?\n\nMotivo: ${reason.trim()}`)) return;
    if (preview.mode === 'checkout') {
      const result = await run('checkout', () => json(`/api/admin/tenants/${tenantId}/billing/checkout-session`, { method: 'POST', headers: { 'idempotency-key': idempotency('admin-checkout', tenantId) }, body: JSON.stringify({ planCode, interval, totalSdrSeats: seats, reason: reason.trim() }) }), 'Checkout criado. Envie o link para a organização concluir o pagamento.');
      if (result?.url) setCheckoutUrl(String(result.url));
    } else {
      await run('plan-change', () => json(`/api/admin/tenants/${tenantId}/billing/plan-change`, { method: 'POST', headers: { 'idempotency-key': idempotency('admin-plan', tenantId) }, body: JSON.stringify({ planCode, interval, totalSdrSeats: seats, reason: reason.trim() }) }), 'Alteração de plano enviada ao Stripe.');
    }
  };

  const saveSeats = async () => {
    if (!requireReason()) return;
    if (seats < lockedFloor) { setMessage(`Redução bloqueada: ${lockedFloor} SDRs estão ativos ou reservados.`); return; }
    const effective = seats < int(billing?.totalSdrSeats ?? billing?.maxSdrs, included) ? 'no fim do ciclo' : 'imediatamente';
    if (!window.confirm(`Ajustar para ${seats} SDRs ${effective}?\n\nMotivo: ${reason.trim()}`)) return;
    await run('seats', () => json(`/api/admin/tenants/${tenantId}/billing/seats`, { method: 'POST', headers: { 'idempotency-key': idempotency('admin-seats', tenantId) }, body: JSON.stringify({ totalSdrSeats: seats, reason: reason.trim() }) }), 'Quantidade de SDRs atualizada.');
  };

  const openPortal = async () => {
    const result = await run('portal', () => json(`/api/admin/tenants/${tenantId}/billing/portal-session`, { method: 'POST' }), 'Portal de cobrança aberto.');
    if (result?.url) window.open(String(result.url), '_blank', 'noopener,noreferrer');
  };

  const reconcile = async () => { await run('reconcile', () => json(`/api/admin/tenants/${tenantId}/billing/reconcile`, { method: 'POST' }), 'Dados reconciliados com o Stripe.'); };
  const copyCheckout = async () => { if (!checkoutUrl) return; await navigator.clipboard?.writeText(checkoutUrl); setSuccess('Link de checkout copiado.'); };
  const cancelPending = async () => {
    const pending = billing?.pendingChanges?.[0];
    if (!pending?.id || !window.confirm('Cancelar a alteração de cobrança pendente?')) return;
    await run('cancel', () => json(`/api/admin/tenants/${tenantId}/billing/changes/${pending.id}`, { method: 'DELETE' }), 'Alteração pendente cancelada.');
  };

  if (busy === 'load' && !billing) return <section className="admin-billing-panel"><div className="admin-billing-loading">Carregando cobrança…</div></section>;

  return <section className="admin-billing-panel" aria-label="Plano e cobrança">
    <div className="admin-billing-heading"><div><span className="eyebrow">COBRANÇA</span><h3>Plano e SDRs</h3><p>Assinatura Stripe e capacidade comercial da organização.</p></div><div className="admin-billing-actions"><Badge tone={active ? 'success' : status === 'past_due' || status === 'unpaid' ? 'warning' : 'neutral'}>{statusLabels[status] ?? status}</Badge><Button variant="ghost" icon="refresh" onClick={() => void load()} disabled={busy !== ''}>Atualizar</Button></div></div>
    {message && <p className="admin-billing-message error" role="alert">{message}</p>}
    {success && <p className="admin-billing-message success" role="status">{success}</p>}
    <div className="admin-billing-stats"><div><span>Plano</span><strong>{billing?.planName ?? 'Nenhum plano'}</strong><small>{billing?.subscription?.billing_interval === 'year' ? 'Ciclo anual' : billing?.subscription ? 'Ciclo mensal' : 'Checkout necessário'}</small></div><div><span>SDRs</span><strong>{int(billing?.totalSdrSeats ?? billing?.maxSdrs, 0)} / {int(billing?.planMaxSdrs, 0) || '—'}</strong><small>{used} ativos · {reserved} reservados</small></div><div><span>Próxima cobrança</span><strong>{date(billing?.subscription?.current_period_end)}</strong><small>{billing?.subscription?.cancel_at_period_end ? 'Cancelamento agendado' : 'Controlada pelo Stripe'}</small></div></div>
    {billing?.pendingChanges?.[0] && <div className="admin-billing-pending"><div><strong>Alteração pendente</strong><small>{billing.pendingChanges[0].change_type === 'plan_change' ? `Plano: ${billing.pendingChanges[0].from_plan_code ?? '—'} → ${billing.pendingChanges[0].to_plan_code ?? '—'}` : `Seats: ${billing.pendingChanges[0].from_seat_quantity ?? '—'} → ${billing.pendingChanges[0].to_seat_quantity ?? '—'}`} · {billing.pendingChanges[0].status === 'scheduled' ? `efetiva em ${date(billing.pendingChanges[0].effective_at)}` : 'aguardando pagamento'}</small></div>{billing.pendingChanges[0].status === 'scheduled' && <Button variant="ghost" onClick={() => void cancelPending()} disabled={busy !== ''}>Cancelar</Button>}</div>}
    <div className="admin-billing-form"><label>Plano<select value={planCode} onChange={(event) => { const next = plans.find((item) => String(item.code) === event.target.value); const nextIncluded = int(next?.included_sdrs, 1); const nextMax = Math.max(nextIncluded, int(next?.max_sdrs, nextIncluded)); setPlanCode(event.target.value); setSeats(Math.min(nextMax, Math.max(nextIncluded, seats))); }} disabled={busy !== ''}>{plans.map((plan) => <option key={String(plan.code)} value={String(plan.code)}>{plan.display_name ?? plan.code} · {int(plan.included_sdrs)} incluídos</option>)}</select></label><label>Ciclo<select value={interval} onChange={(event) => setInterval(event.target.value as Interval)} disabled={busy !== '' || active}><option value="month">Mensal</option><option value="year">Anual</option></select>{active && <small>Para trocar o ciclo, use o Portal Stripe.</small>}</label><label>Quantidade total de SDRs<div className="admin-seat-control"><button type="button" aria-label="Remover SDR" onClick={() => setSeats(Math.max(included, seats - 1))} disabled={busy !== '' || seats <= included || seats <= lockedFloor}>−</button><output aria-live="polite">{seats}</output><button type="button" aria-label="Adicionar SDR" onClick={() => setSeats(Math.min(max, seats + 1))} disabled={busy !== '' || seats >= max}>+</button></div><small>{included} incluídos{extra ? ` + ${extra} adicional${extra === 1 ? '' : 'is'}` : ''} · limite comercial {max}</small></label><label className="admin-billing-reason">Motivo da alteração<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex.: upgrade solicitado pelo cliente" maxLength={500} /></label></div>
    <div className="admin-billing-total"><span>Total estimado</span><strong>{base ? money(total, base.currency) : 'Preço não configurado'}</strong><small>{extra ? `${extra} SDR${extra === 1 ? '' : 's'} adicional${extra === 1 ? '' : 'is'} · ${addon ? money(addon.amount, addon.currency) : 'adicional não configurado'} cada` : 'Sem custo adicional de SDR'}</small></div>
    <div className="admin-billing-footer">{active && samePlan ? <Button onClick={() => void saveSeats()} disabled={busy !== '' || !billing?.stripeConfigured}>{busy === 'seats' ? 'Salvando…' : 'Salvar quantidade de SDRs'}</Button> : <Button onClick={() => void apply()} disabled={busy !== '' || !selectedPlan || !billing?.stripeConfigured}>{busy === 'preview' || busy === 'checkout' || busy === 'plan-change' ? 'Processando…' : active ? 'Aplicar troca de plano' : 'Gerar checkout'}</Button>}{active && <Button variant="secondary" onClick={() => void openPortal()} disabled={busy !== '' || !billing?.customer}>{busy === 'portal' ? 'Abrindo…' : 'Portal Stripe'}</Button>}<Button variant="ghost" onClick={() => void reconcile()} disabled={busy !== ''}>Reconciliar Stripe</Button></div>
    {checkoutUrl && <div className="admin-checkout-link"><Icon name="credit-card" size={15} /><div><strong>Checkout aguardando pagamento</strong><small>Envie este link para o responsável concluir a assinatura.</small><code>{checkoutUrl}</code></div><Button variant="secondary" onClick={() => void copyCheckout()} icon="copy">Copiar link</Button></div>}
  </section>;
}
