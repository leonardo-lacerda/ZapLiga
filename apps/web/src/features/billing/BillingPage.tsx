import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

export type BillingInterval = 'month' | 'year';

const DEFAULT_SEAT_PRICES: Record<BillingInterval, number> = { month: 1990, year: 19900 };
const intervalLabels: Record<BillingInterval, string> = { month: 'mês', year: 'ano' };
const reasonLabel: Record<string, string> = {
  active_subscription: 'Assinatura ativa', trialing: 'Período de avaliação', manual_grant: 'Acesso concedido manualmente',
  no_subscription: 'Sem assinatura ativa', subscription_expired: 'Assinatura expirada', canceled: 'Assinatura cancelada',
  past_due: 'Pagamento pendente', unpaid: 'Pagamento não confirmado',
};
const featureLabels: Record<string, string> = {
  schedule_enforcement: 'Agenda e horários', callbacks: 'Callbacks', privacy_requests: 'Privacidade e compliance', onboarding: 'Onboarding',
  campaigns: 'Campanhas', decision_engine: 'Motor de decisão', recommendations: 'Recomendações', operation_health: 'Saúde da operação',
  analytics_learning: 'Aprendizado analítico', experiments: 'Experimentos', benchmarks: 'Benchmarks', lead_ingestion_api: 'API de leads', advanced_reports: 'Relatórios avançados',
};
const levelLabels: Record<string, string> = { full: 'Completo', basic: 'Básico', read_only: 'Consulta' };
const limitLabels: Record<string, string> = { leads: 'leads', retention_days: 'Histórico de métricas' };

const limitValueLabel = (code: string, value: unknown) => code === 'retention_days'
  ? `${Number(value).toLocaleString('pt-BR')} dias`
  : Number(value).toLocaleString('pt-BR');

const asInteger = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};

const dateLabel = (value: unknown) => {
  if (!value) return '-';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('pt-BR');
};

export const moneyLabel = (amount: unknown, currency = 'brl') => {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency.toUpperCase() }).format(value / 100);
};

export const priceLabel = (price: AnyRow, includeInterval = true) => {
  const label = moneyLabel(price.amount, String(price.currency ?? 'brl'));
  return includeInterval ? `${label}/${intervalLabels[String(price.interval) as BillingInterval] ?? String(price.interval)}` : label;
};

export const calculatePlanTotal = (baseAmount: unknown, includedSeats: unknown, totalSeats: unknown, seatAmount: unknown) => {
  const base = Math.max(0, asInteger(baseAmount));
  const included = Math.max(0, asInteger(includedSeats));
  const total = Math.max(included, asInteger(totalSeats, included));
  const seat = Math.max(0, asInteger(seatAmount));
  return base + Math.max(0, total - included) * seat;
};

const priceForInterval = (plan: AnyRow, interval: BillingInterval) => {
  const prices = Array.isArray(plan.prices) ? plan.prices as AnyRow[] : [];
  return prices.find((price) => String(price.interval) === interval) ?? prices[0] ?? null;
};

const seatPriceForInterval = (plan: AnyRow, plans: AnyRow[], interval: BillingInterval) => {
  const planSeatPrices = Array.isArray(plan.seat_prices) ? plan.seat_prices as AnyRow[] : [];
  const allSeatPrices = plans.flatMap((item) => Array.isArray(item.seat_prices) ? item.seat_prices as AnyRow[] : []);
  return planSeatPrices.find((price) => String(price.interval) === interval)
    ?? allSeatPrices.find((price) => String(price.interval) === interval)
    ?? { amount: DEFAULT_SEAT_PRICES[interval], currency: 'brl', interval };
};

const clampSeats = (value: unknown, included: number, max: number) => Math.min(max, Math.max(included, asInteger(value, included)));

function PlanEntitlements({ plan }: { plan: AnyRow }) {
  const [expanded, setExpanded] = useState(false);
  const features = Object.entries((plan.feature_entitlements ?? {}) as Record<string, unknown>).filter(([, level]) => level !== 'none');
  const limits = Object.entries((plan.limit_entitlements ?? {}) as Record<string, unknown>)
    .filter(([code]) => !['numbers', 'max_concurrent_dialers'].includes(code));
  const visibleFeatures = expanded ? features : features.slice(0, 6);
  return <div className="billing-entitlements">
    {visibleFeatures.length > 0 && <div><p className="billing-subheading">Incluído no plano</p><ul className="billing-feature-list">{visibleFeatures.map(([code, level]) => <li key={code}><Icon name="check" size={13} /><span>{featureLabels[code] ?? code}</span><small>{levelLabels[String(level)] ?? String(level)}</small></li>)}</ul></div>}
    {features.length > 6 && <button type="button" className="billing-link-button" onClick={() => setExpanded((current) => !current)}>{expanded ? 'Mostrar menos' : `Ver todos os recursos (${features.length})`}</button>}
    {limits.length > 0 && <div className="billing-limits"><p className="billing-subheading">Limites do plano</p><div className="billing-limit-list">{limits.map(([code, value]) => <span key={code}>{limitLabels[code] ?? code}: <strong>{limitValueLabel(code, value)}</strong></span>)}</div>{limits.some(([code]) => code === 'retention_days') && <small className="billing-retention-note">Período do histórico de métricas: etapas dos leads, disponibilidade dos SDRs, status das linhas e exportações. Leads e chamadas não são removidos por esta regra.</small>}</div>}
  </div>;
}

type SeatQuantityControlProps = {
  included: number;
  max: number;
  value: number;
  seatPrice: AnyRow;
  interval: BillingInterval;
  onChange: (value: number) => void;
  disabled?: boolean;
};

export function SeatQuantityControl({ included, max, value, seatPrice, interval, onChange, disabled = false }: SeatQuantityControlProps) {
  const safeValue = clampSeats(value, included, max);
  const extra = Math.max(0, safeValue - included);
  return <div className="billing-seat-control">
    <div className="billing-seat-control-heading"><div><span className="billing-subheading">Quantidade de SDRs</span><strong>{safeValue} SDRs</strong></div><span className="billing-seat-breakdown">{included} incluídos{extra ? ` + ${extra} adicional${extra === 1 ? '' : 'is'}` : ''}</span></div>
    <div className="billing-seat-actions">
      <button type="button" className="billing-seat-stepper" aria-label="Remover um SDR" disabled={disabled || safeValue <= included} onClick={() => onChange(clampSeats(safeValue - 1, included, max))}>−</button>
      <output className="billing-seat-count" aria-label="Quantidade total de SDRs" aria-live="polite">{safeValue}</output>
      <button type="button" className="billing-seat-stepper" aria-label="Adicionar um SDR" disabled={disabled || safeValue >= max} onClick={() => onChange(clampSeats(safeValue + 1, included, max))}>+</button>
      <Button type="button" variant="secondary" className="billing-add-seat-button" disabled={disabled || safeValue >= max} onClick={() => onChange(clampSeats(safeValue + 1, included, max))} icon="plus">Adicionar mais SDR</Button>
    </div>
    <small className="billing-seat-help">Cada SDR adicional: {priceLabel({ ...seatPrice, interval }, true)} · limite: {max}</small>
    {safeValue >= max && <small className="billing-cap-reached">Limite deste plano atingido. Faça upgrade para continuar.</small>}
  </div>;
}

type PlanCardProps = {
  plan: AnyRow;
  plans: AnyRow[];
  interval: BillingInterval;
  selectedSeats: number;
  selected?: boolean;
  current?: boolean;
  full: boolean;
  busy: string;
  onSelect: () => void;
  onSeatsChange: (value: number) => void;
  onAction: () => void;
};

function PlanCard({ plan, plans, interval, selectedSeats, selected = false, current = false, full, busy, onSelect, onSeatsChange, onAction }: PlanCardProps) {
  const included = Math.max(1, asInteger(plan.included_sdrs, 1));
  const max = Math.max(included, asInteger(plan.max_sdrs, included));
  const price = priceForInterval(plan, interval);
  const seatPrice = seatPriceForInterval(plan, plans, interval);
  const total = price ? calculatePlanTotal(price.amount, included, selectedSeats, seatPrice.amount) : 0;
  const actionKey = `${full ? 'plan' : 'checkout'}:${plan.code}:${interval}`;
  const actionLabel = full ? `Mudar para ${plan.display_name ?? plan.code}` : 'Assinar este plano';
  return <article className={`billing-plan-card${selected ? ' is-selected' : ''}${current ? ' is-current' : ''}`} onClick={onSelect}>
    <div className="billing-plan-head"><div><span className="eyebrow">{String(plan.code).toUpperCase()}</span><h3>{plan.display_name ?? plan.code}</h3></div>{current ? <Badge tone="success">Plano atual</Badge> : selected ? <Badge tone="info">Selecionado</Badge> : null}</div>
    <p className="billing-plan-description">{plan.description ?? 'Para organizar sua operação comercial com mais previsibilidade.'}</p>
    <div className="billing-plan-price"><span>A partir de</span><strong>{price ? moneyLabel(price.amount, String(price.currency ?? 'brl')) : '-'}</strong><small>/{intervalLabels[interval]} · base do plano</small></div>
    <div className="billing-plan-capacity"><strong>{included} SDRs incluídos</strong><span>até {max} SDRs neste plano</span></div>
    <SeatQuantityControl included={included} max={max} value={selectedSeats} seatPrice={seatPrice} interval={interval} onChange={(value) => { onSelect(); onSeatsChange(value); }} disabled={Boolean(busy)} />
    <div className="billing-plan-total"><span>Total {interval === 'month' ? 'mensal' : 'anual'}</span><strong>{moneyLabel(total, String(price?.currency ?? 'brl'))}</strong><small>{selectedSeats - included > 0 ? `${selectedSeats - included} adicional${selectedSeats - included === 1 ? '' : 'is'}${interval === 'year' ? ' no ciclo anual' : ''}` : 'sem custo adicional de SDR'}</small></div>
    <PlanEntitlements plan={plan} />
    <div className="billing-plan-footer"><Button type="button" className="billing-plan-action" disabled={Boolean(busy) || !price} onClick={(event) => { event.stopPropagation(); onSelect(); onAction(); }}>{busy === actionKey ? (full ? 'Calculando…' : 'Abrindo checkout…') : `${actionLabel} · ${moneyLabel(total, String(price?.currency ?? 'brl'))}/${intervalLabels[interval]}`}</Button></div>
  </article>;
}

function IntervalSelector({ interval, onChange, disabled = false }: { interval: BillingInterval; onChange: (value: BillingInterval) => void; disabled?: boolean }) {
  return <div className="billing-interval-selector" role="group" aria-label="Ciclo de cobrança"><span>Ciclo de cobrança</span><div>{(['month', 'year'] as BillingInterval[]).map((item) => <button type="button" key={item} className={interval === item ? 'is-active' : ''} aria-pressed={interval === item} disabled={disabled} onClick={() => onChange(item)}>{item === 'month' ? 'Mensal' : 'Anual'}</button>)}</div></div>;
}

export function BillingPage({ tenantId, isSuperAdmin = false }: { tenantId: string; isSuperAdmin?: boolean }) {
  const [billing, setBilling] = useState<AnyRow | null>(null);
  const [plans, setPlans] = useState<AnyRow[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [selectedPlanCode, setSelectedPlanCode] = useState('');
  const [seatSelections, setSeatSelections] = useState<Record<string, number>>({});
  const [seatTarget, setSeatTarget] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [nextBilling, nextPlans] = await Promise.all([json(`/api/tenants/${tenantId}/billing`), json(`/api/tenants/${tenantId}/billing/plans`)]);
      const catalog = Array.isArray(nextPlans) ? nextPlans as AnyRow[] : [];
      setBilling(nextBilling);
      setPlans(catalog);
      const activePlanCode = String(nextBilling?.planCode ?? '');
      const activeSeatTotal = Number(nextBilling?.includedSdrs ?? 0) + Number(nextBilling?.purchasedExtraSdrs ?? 0);
      const preferredPlanCode = nextBilling?.mode === 'full' ? activePlanCode : '';
      setSelectedPlanCode((current) => current && catalog.some((plan) => plan.code === current) ? current : (preferredPlanCode || String(catalog[0]?.code ?? '')));
      setSeatSelections((current) => Object.fromEntries(catalog.map((plan) => {
        const included = Math.max(1, asInteger(plan.included_sdrs, 1));
        const max = Math.max(included, asInteger(plan.max_sdrs, included));
        const defaultSeats = String(plan.code) === activePlanCode ? Math.max(included, activeSeatTotal) : included;
        return [String(plan.code), clampSeats(current[String(plan.code)] ?? defaultSeats, included, max)];
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const full = billing?.mode === 'full';
  const subscription = billing?.subscription;
  const currentSeatTotal = Number(billing?.includedSdrs ?? 0) + Number(billing?.purchasedExtraSdrs ?? 0);
  const activeInterval = (String(subscription?.billing_interval ?? '') === 'year' ? 'year' : 'month') as BillingInterval;
  const checkoutInterval = full ? activeInterval : interval;
  const selectedPlan = plans.find((plan) => String(plan.code) === selectedPlanCode) ?? plans[0];
  const selectedIncluded = selectedPlan ? Math.max(1, asInteger(selectedPlan.included_sdrs, 1)) : 1;
  const selectedMax = selectedPlan ? Math.max(selectedIncluded, asInteger(selectedPlan.max_sdrs, selectedIncluded)) : selectedIncluded;
  const selectedSeats = selectedPlan ? clampSeats(seatSelections[String(selectedPlan.code)] ?? (full ? Math.max(selectedIncluded, currentSeatTotal) : selectedIncluded), selectedIncluded, selectedMax) : 0;
  const selectedPrice = selectedPlan ? priceForInterval(selectedPlan, checkoutInterval) : null;
  const selectedSeatPrice = selectedPlan ? seatPriceForInterval(selectedPlan, plans, checkoutInterval) : { amount: DEFAULT_SEAT_PRICES[checkoutInterval], currency: 'brl', interval: checkoutInterval };
  const selectedTotal = selectedPrice ? calculatePlanTotal(selectedPrice.amount, selectedIncluded, selectedSeats, selectedSeatPrice.amount) : 0;

  useEffect(() => {
    if (full && billing) setSeatTarget(currentSeatTotal);
  }, [billing, currentSeatTotal, full]);

  const updatePlanSeats = (plan: AnyRow, value: number) => {
    const included = Math.max(1, asInteger(plan.included_sdrs, 1));
    const max = Math.max(included, asInteger(plan.max_sdrs, included));
    setSeatSelections((current) => ({ ...current, [String(plan.code)]: clampSeats(value, included, max) }));
  };

  const openCheckout = async (plan: AnyRow) => {
    const planCode = String(plan.code);
    const selected = clampSeats(seatSelections[planCode] ?? asInteger(plan.included_sdrs, 1), asInteger(plan.included_sdrs, 1), asInteger(plan.max_sdrs, asInteger(plan.included_sdrs, 1)));
    setBusy(`checkout:${planCode}:${checkoutInterval}`); setError('');
    try {
      const result = await json(`/api/tenants/${tenantId}/billing/checkout-session`, { method: 'POST', headers: { 'idempotency-key': `checkout:${tenantId}:${planCode}:${checkoutInterval}:${selected}:${Date.now()}` }, body: JSON.stringify({ planCode, interval: checkoutInterval, totalSdrSeats: selected }) });
      if (result.url) window.location.assign(result.url);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const changeSeats = async () => {
    const max = Number(billing?.planMaxSdrs ?? billing?.maxSdrs ?? 100000);
    const min = Math.max(1, Number(billing?.includedSdrs ?? 1));
    const target = Math.min(max, Math.max(min, Math.floor(Number(seatTarget ?? currentSeatTotal))));
    setBusy('seats'); setError('');
    try {
      const preview = await json(`/api/tenants/${tenantId}/billing/seats/preview`, { method: 'POST', body: JSON.stringify({ totalSdrSeats: target }) });
      const confirmed = typeof window === 'undefined' || window.confirm(`Alterar para ${preview.targetTotalSeats} SDRs? A alteração será ${preview.effectiveAt === 'period_end' ? 'agendada para o fim do ciclo' : 'enviada para confirmação de pagamento'}.`);
      if (!confirmed) return;
      await json(`/api/tenants/${tenantId}/billing/seats`, { method: 'POST', headers: { 'idempotency-key': `seats:${tenantId}:${target}:${Date.now()}` }, body: JSON.stringify({ totalSdrSeats: target }) });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const changePlan = async (plan: AnyRow) => {
    const planCode = String(plan.code);
    const included = Math.max(1, asInteger(plan.included_sdrs, 1));
    const max = Math.max(included, asInteger(plan.max_sdrs, included));
    const targetSeats = clampSeats(seatSelections[planCode] ?? Math.max(included, currentSeatTotal), included, max);
    setBusy(`plan:${planCode}:${activeInterval}`); setError('');
    try {
      const body = { planCode, interval: activeInterval, totalSdrSeats: targetSeats };
      const preview = await json(`/api/tenants/${tenantId}/billing/plan-change/preview`, { method: 'POST', body: JSON.stringify(body) });
      const confirmed = typeof window === 'undefined' || window.confirm(`Mudar para ${preview.targetPlanName} com ${preview.targetTotalSeats} SDRs? A alteração será ${preview.effectiveAt === 'period_end' ? 'agendada para o fim do ciclo' : 'enviada para confirmação de pagamento'}.`);
      if (!confirmed) return;
      await json(`/api/tenants/${tenantId}/billing/plan-change`, { method: 'POST', headers: { 'idempotency-key': `plan:${tenantId}:${planCode}:${activeInterval}:${targetSeats}:${Date.now()}` }, body: JSON.stringify(body) });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  const openPortal = async () => { setBusy('portal'); setError(''); try { const result = await json(`/api/tenants/${tenantId}/billing/portal-session`, { method: 'POST', body: JSON.stringify({ returnUrl: window.location.href }) }); if (result.url) window.location.assign(result.url); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };
  const reconcile = async () => { setBusy('reconcile'); setError(''); try { await json(`/api/tenants/${tenantId}/billing/reconcile`, { method: 'POST' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };
  const cancelChange = async (id: string) => { setBusy(`cancel:${id}`); setError(''); try { await json(`/api/tenants/${tenantId}/billing/changes/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };

  const planCards = useMemo(() => full ? plans.filter((plan) => String(plan.code) !== String(billing?.planCode ?? '')) : plans, [billing?.planCode, full, plans]);

  return <div className="page-content billing-page" aria-busy={loading}>
    <div className="page-heading billing-page-heading"><div><span className="eyebrow">ORGANIZAÇÃO</span><h1>Plano e cobrança</h1><p>Escolha seu plano, ajuste a equipe e acompanhe tudo em um só lugar.</p></div><div className="billing-heading-actions"><Badge tone={full ? 'success' : 'warning'}>{full ? 'Operação liberada' : 'Somente leitura'}</Badge>{subscription && <Button variant="secondary" icon="credit-card" onClick={() => void openPortal()} disabled={busy !== ''}>{busy === 'portal' ? 'Abrindo…' : 'Gerenciar pagamentos'}</Button>}</div></div>
    {error && <div className="alert" role="alert"><Icon name="alert" size={16} /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Fechar erro"><Icon name="close" size={15} /></button></div>}
    <Panel className="billing-status-panel"><SectionHeader eyebrow="STATUS ATUAL" title={reasonLabel[billing?.reason] ?? (loading ? 'Consultando assinatura…' : 'Assinatura não encontrada')} action={<Button variant="ghost" icon="refresh" onClick={() => void load()} disabled={busy !== '' || loading}>Atualizar</Button>} /><div className="billing-status-grid"><div><span>Plano</span><strong>{billing?.planName ?? 'Nenhum plano'}</strong><small>{subscription?.status ? `Stripe: ${subscription.status}` : 'Ative um plano para liberar alterações.'}</small></div><div><span>SDRs</span><strong>{billing ? `${billing.usedSdrSeats ?? 0} ativos · ${billing.maxSdrs ?? 'sem limite'}` : '-'}</strong><small>{billing?.reservedSdrSeats ?? 0} convites reservados</small></div><div><span>Acesso até</span><strong>{dateLabel(billing?.accessUntil)}</strong><small>{billing?.cancelAtPeriodEnd ? 'Cancelamento ao fim do ciclo' : 'Renovação controlada pelo Stripe'}</small></div><div><span>Recursos</span><strong>{full ? 'Liberados' : 'Consulta'}</strong><small>{full ? 'Plano confirmado' : 'Dados preservados'}</small></div></div></Panel>
    {full && <Panel className="billing-capacity-panel"><SectionHeader eyebrow="CAPACIDADE DA EQUIPE" title="Gerencie seus SDRs" description="Adicione ou remova seats. A cobrança é atualizada pelo Stripe após a confirmação." /><SeatQuantityControl included={Math.max(1, Number(billing?.includedSdrs ?? 1))} max={Math.max(1, Number(billing?.planMaxSdrs ?? billing?.maxSdrs ?? 100000))} value={seatTarget ?? Math.max(1, currentSeatTotal)} seatPrice={seatPriceForInterval(selectedPlan ?? {}, plans, activeInterval)} interval={activeInterval} onChange={setSeatTarget} disabled={busy !== ''} /><div className="billing-capacity-footer"><span>{Number(billing?.purchasedExtraSdrs ?? 0)} seats adicionais pagos · teto comercial: {billing?.planMaxSdrs ?? billing?.maxSdrs ?? '-'}</span><Button disabled={busy !== '' || !subscription || seatTarget === null || seatTarget === currentSeatTotal} onClick={() => void changeSeats()}>{busy === 'seats' ? 'Calculando…' : 'Salvar alteração'}</Button></div></Panel>}
    {Boolean(billing?.pendingChanges?.length) && <Panel className="billing-pending-panel"><SectionHeader eyebrow="ALTERAÇÃO PENDENTE" title="Aguardando cobrança" description="O novo limite só muda após confirmação do Stripe." />{billing?.pendingChanges?.map((change: AnyRow) => <div className="admin-compact-row" key={change.id}><div><strong>{change.change_type === 'plan_change' ? `Plano: ${change.to_plan_code}` : `SDRs: ${change.to_seat_quantity}`}</strong><small>{change.status === 'scheduled' ? `Efetiva em ${dateLabel(change.effective_at)}` : 'Confirmando pagamento'}</small></div>{change.status === 'scheduled' && <Button variant="ghost" onClick={() => void cancelChange(String(change.id))} disabled={busy !== ''}>Cancelar</Button>}</div>)}</Panel>}
    {!full && <Panel className="billing-plans-panel"><div className="billing-plans-heading"><div><span className="eyebrow">ESCOLHA SEU PLANO</span><h2>Comece com a equipe certa</h2><p>Todos os planos já começam com a quantidade de SDRs incluída. Use <strong>Adicionar mais SDR</strong> para ajustar o total.</p></div><IntervalSelector interval={interval} onChange={setInterval} disabled={busy !== ''} /></div><div className="billing-plan-grid">{planCards.map((plan) => { const included = Math.max(1, asInteger(plan.included_sdrs, 1)); const max = Math.max(included, asInteger(plan.max_sdrs, included)); const value = clampSeats(seatSelections[String(plan.code)] ?? included, included, max); return <PlanCard key={String(plan.code)} plan={plan} plans={plans} interval={interval} selectedSeats={value} selected={String(plan.code) === selectedPlanCode} full={false} busy={busy} onSelect={() => setSelectedPlanCode(String(plan.code))} onSeatsChange={(next) => updatePlanSeats(plan, next)} onAction={() => void openCheckout(plan)} />; })}</div>{!plans.length && !loading && <p className="text-muted">Nenhum preço foi publicado para este ambiente.</p>}</Panel>}
    {full && <Panel className="billing-plans-panel"><div className="billing-plans-heading"><div><span className="eyebrow">MUDAR DE PLANO</span><h2>Compare os próximos níveis</h2><p>O ciclo atual é <strong>{intervalLabels[activeInterval]}</strong>. Os recursos são liberados após a confirmação financeira.</p></div></div><div className="billing-plan-grid">{planCards.map((plan) => { const included = Math.max(1, asInteger(plan.included_sdrs, 1)); const max = Math.max(included, asInteger(plan.max_sdrs, included)); const value = clampSeats(seatSelections[String(plan.code)] ?? Math.max(included, currentSeatTotal), included, max); return <PlanCard key={String(plan.code)} plan={plan} plans={plans} interval={activeInterval} selectedSeats={value} full current={false} busy={busy} onSelect={() => setSelectedPlanCode(String(plan.code))} onSeatsChange={(next) => updatePlanSeats(plan, next)} onAction={() => void changePlan(plan)} />; })}</div>{!planCards.length && <p className="text-muted">Você já está no plano mais completo do catálogo.</p>}</Panel>}
    {selectedPlan && <Panel className="billing-summary-panel"><div className="billing-summary-content"><div><span className="eyebrow">RESUMO DA CONTRATAÇÃO</span><h2>{selectedPlan.display_name ?? selectedPlan.code}</h2><p>{selectedSeats} SDRs · {selectedSeats - selectedIncluded} adicional{selectedSeats - selectedIncluded === 1 ? '' : 'is'}</p></div><div className="billing-summary-values"><span>Plano base <strong>{selectedPrice ? priceLabel(selectedPrice, false) : '-'}</strong></span><span>Adicionais <strong>{moneyLabel(Math.max(0, selectedSeats - selectedIncluded) * asInteger(selectedSeatPrice.amount), String(selectedSeatPrice.currency ?? 'brl'))}</strong></span><strong className="billing-summary-total">{moneyLabel(selectedTotal, String(selectedPrice?.currency ?? 'brl'))}<small>/{intervalLabels[checkoutInterval]}</small></strong></div></div></Panel>}
    {subscription && <Panel className="billing-payment-panel"><SectionHeader eyebrow="GERENCIAMENTO" title="Dados de pagamento" description="Atualize cartão, endereço e assinatura pelo portal seguro do Stripe." action={<Button onClick={() => void openPortal()} disabled={busy !== ''}>{busy === 'portal' ? 'Abrindo…' : 'Abrir portal Stripe'}</Button>} />{isSuperAdmin && <div className="table-actions"><Button variant="ghost" icon="refresh" onClick={() => void reconcile()} disabled={busy !== ''}>{busy === 'reconcile' ? 'Sincronizando…' : 'Sincronizar agora'}</Button></div>}</Panel>}
  </div>;
}
