import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { StripeClientService } from '../../infrastructure/stripe/stripe.client';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from './entitlement.service';

const asDate = (seconds: unknown) => EntitlementService.providerDate(seconds);

type BillingCommandOptions = {
  bypassEntitlement?: boolean;
  source?: 'organization' | 'admin';
  reason?: string;
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly stripe: StripeClientService,
    private readonly entitlement: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async getTenantBilling(tenantId: string) {
    const access = await this.entitlement.getAccess(tenantId);
    const account = await this.db.query('SELECT tenant_id, stripe_customer_id, billing_email, livemode, last_reconciled_at FROM tenant_billing_accounts WHERE tenant_id = $1 AND livemode = $2', [tenantId, this.stripe.livemode]);
    const subscription = await this.db.query(`
      SELECT ts.stripe_subscription_id, ts.stripe_price_id, ts.status, ts.current_period_start,
        ts.current_period_end, ts.trial_end, ts.cancel_at_period_end, ts.latest_invoice_id,
        ts.latest_invoice_status, ts.access_until, ts.last_synced_at, pp.billing_interval,
        pv.code AS plan_code, pv.display_name AS plan_name, pv.max_sdrs
      FROM tenant_subscriptions ts
      LEFT JOIN billing_plan_versions pv ON pv.id = ts.plan_version_id
      LEFT JOIN billing_plan_prices pp ON pp.stripe_price_id = ts.stripe_price_id AND pp.livemode = ts.livemode
      WHERE ts.tenant_id = $1 AND ts.livemode = $2
      ORDER BY ts.updated_at DESC LIMIT 1
    `, [tenantId, this.stripe.livemode]);
    const pendingChanges = await this.db.query(`SELECT id, change_type, from_plan_code, to_plan_code, from_seat_quantity, to_seat_quantity, status, effective_at, requested_source, request_reason, created_at FROM tenant_billing_changes WHERE tenant_id = $1 AND status IN ('pending_payment', 'scheduled') ORDER BY created_at DESC`, [tenantId]);
    return {
      ...access,
      totalSdrSeats: access.maxSdrs ?? null,
      enforcementMode: this.entitlement.enforcementMode,
      stripeConfigured: this.stripe.configured,
      customer: account.rows[0] ?? null,
      subscription: subscription.rows[0] ?? null,
      pendingChanges: pendingChanges.rows,
    };
  }

  async listPlans() {
    const result = await this.db.query(`
      SELECT pv.code, pv.display_name, pv.description, pv.max_sdrs, pv.included_sdrs,
        pv.feature_entitlements, pv.limit_entitlements, pv.service_level,
        jsonb_agg(jsonb_build_object('interval', pp.billing_interval, 'priceId', pp.stripe_price_id, 'amount', pp.unit_amount, 'currency', pp.currency) ORDER BY pp.billing_interval) AS prices,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('interval', ap.billing_interval, 'priceId', ap.stripe_price_id, 'amount', ap.unit_amount, 'currency', ap.currency) ORDER BY ap.billing_interval)
          FROM billing_addon_prices ap WHERE ap.addon_code = 'sdr_seat' AND ap.active = true AND ap.livemode = $1), '[]'::jsonb) AS seat_prices
      FROM billing_plan_versions pv
      JOIN billing_plan_prices pp ON pp.plan_version_id = pv.id
      WHERE pv.status = 'active' AND pp.active = true AND pp.livemode = $1
        AND pp.billing_interval IN ('month', 'year')
      GROUP BY pv.id
      ORDER BY pv.sort_order, pv.version DESC
    `, [this.stripe.livemode]);
    return result.rows;
  }

  async previewPlanChange(tenantId: string, toPlanCode: string, interval?: 'month' | 'year', requestedTotalSeats?: number) {
    const access = await this.entitlement.getAccess(tenantId);
    if (!access.planCode || access.includedSdrs == null || access.maxSdrs == null) throw new ConflictException('A organização ainda não possui uma assinatura ativa');
    const subscription = await this.db.query(`SELECT ts.id, ts.stripe_subscription_id, ts.current_period_end, pv.sort_order, pp.billing_interval FROM tenant_subscriptions ts JOIN billing_plan_versions pv ON pv.id = ts.plan_version_id LEFT JOIN billing_plan_prices pp ON pp.stripe_price_id = ts.stripe_price_id AND pp.livemode = ts.livemode WHERE ts.tenant_id = $1 AND ts.livemode = $2 AND ts.ended_at IS NULL ORDER BY ts.updated_at DESC LIMIT 1`, [tenantId, this.stripe.livemode]);
    if (!subscription.rows[0]) throw new ConflictException('Assinatura ativa não encontrada');
    const currentInterval = subscription.rows[0].billing_interval as 'month' | 'year' | null;
    if (interval && currentInterval && interval !== currentInterval) {
      throw new ConflictException('A troca de ciclo deve ser feita pelo portal Stripe ou por uma nova assinatura');
    }
    const targetPrice = await this.requirePrice(toPlanCode, interval ?? currentInterval ?? 'month');
    if (String(targetPrice.code) === String(access.planCode)) throw new ConflictException('O plano escolhido já está ativo');
    const currentTotalSeats = Number(access.includedSdrs) + Number(access.purchasedExtraSdrs ?? 0);
    const targetTotalSeats = requestedTotalSeats == null
      ? Math.max(currentTotalSeats, Number(targetPrice.included_sdrs))
      : Math.floor(Number(requestedTotalSeats));
    if (!Number.isInteger(targetTotalSeats) || targetTotalSeats < Number(targetPrice.included_sdrs)) throw new ConflictException(`O plano ${targetPrice.code} exige pelo menos ${targetPrice.included_sdrs} SDRs`);
    if (targetTotalSeats < Number(access.usedSdrSeats ?? 0) + Number(access.reservedSdrSeats ?? 0)) throw new ConflictException(`Não é possível reduzir abaixo de ${Number(access.usedSdrSeats ?? 0) + Number(access.reservedSdrSeats ?? 0)} SDRs em uso ou convite pendente`);
    if (targetTotalSeats > Number(targetPrice.max_sdrs)) throw new ConflictException({ code: 'seat_cap_exceeded', message: `O plano ${targetPrice.code} não comporta os ${targetTotalSeats} SDRs solicitados.`, currentTotalSeats, limit: Number(targetPrice.max_sdrs) });
    const usage = await this.db.query('SELECT count(*)::int AS leads FROM leads WHERE tenant_id = $1', [tenantId]);
    const limits = targetPrice.limit_entitlements ?? {};
    if (Number(usage.rows[0]?.leads ?? 0) > Number(limits.leads ?? Number.MAX_SAFE_INTEGER)) throw new ConflictException({ code: 'plan_limit_below_usage', message: 'O uso atual excede os limites do plano escolhido.', usage: usage.rows[0], limits });
    const currentSort = Number(subscription.rows[0].sort_order ?? 0);
    const targetSort = Number(targetPrice.sort_order ?? 0);
    const effectiveAt = targetSort < currentSort ? 'period_end' as const : 'immediate' as const;
    return { currentPlanCode: access.planCode, currentTotalSeats, targetPlanCode: targetPrice.code, targetPlanVersionId: targetPrice.plan_version_id, targetPlanName: targetPrice.display_name, targetPriceId: targetPrice.stripe_price_id, targetTotalSeats, extraSeats: Math.max(0, targetTotalSeats - Number(targetPrice.included_sdrs)), interval: targetPrice.billing_interval, effectiveAt, currentPeriodEnd: subscription.rows[0].current_period_end ?? null, price: { amount: Number(targetPrice.unit_amount), currency: targetPrice.currency } };
  }

  async previewNewSubscription(planCode: string, interval: 'month' | 'year', requestedTotalSeats?: number) {
    const price = await this.requirePrice(planCode, interval);
    const targetTotalSeats = requestedTotalSeats == null ? Number(price.included_sdrs) : Math.floor(Number(requestedTotalSeats));
    if (!Number.isInteger(targetTotalSeats) || targetTotalSeats < Number(price.included_sdrs)) {
      throw new ConflictException(`O plano ${price.code} exige pelo menos ${price.included_sdrs} SDRs`);
    }
    if (targetTotalSeats > Number(price.max_sdrs)) {
      throw new ConflictException({ code: 'seat_cap_exceeded', message: `O plano ${price.code} não comporta os ${targetTotalSeats} SDRs solicitados.`, limit: Number(price.max_sdrs) });
    }
    const addon = targetTotalSeats > Number(price.included_sdrs) ? await this.requireSeatAddon(interval) : null;
    const baseAmount = Number(price.unit_amount);
    const seatAmount = Number(addon?.unit_amount ?? 0);
    return {
      mode: 'checkout' as const,
      targetPlanCode: price.code,
      targetPlanVersionId: price.plan_version_id,
      targetPlanName: price.display_name,
      targetPriceId: price.stripe_price_id,
      targetTotalSeats,
      includedSdrs: Number(price.included_sdrs),
      maxSdrs: Number(price.max_sdrs),
      extraSeats: Math.max(0, targetTotalSeats - Number(price.included_sdrs)),
      interval: price.billing_interval,
      effectiveAt: 'after_payment' as const,
      price: { amount: baseAmount + Math.max(0, targetTotalSeats - Number(price.included_sdrs)) * seatAmount, baseAmount, seatAmount, currency: price.currency },
    };
  }

  async previewAdminChange(tenantId: string, planCode: string, interval: 'month' | 'year', requestedTotalSeats?: number) {
    const existing = await this.db.query(`
      SELECT ts.id
      FROM tenant_subscriptions ts
      WHERE ts.tenant_id = $1 AND ts.livemode = $2 AND ts.ended_at IS NULL
        AND ts.status NOT IN ('canceled', 'incomplete_expired')
      ORDER BY ts.updated_at DESC LIMIT 1
    `, [tenantId, this.stripe.livemode]);
    if (existing.rows[0]) return { ...(await this.previewPlanChange(tenantId, planCode, interval, requestedTotalSeats)), mode: 'change' as const };
    return this.previewNewSubscription(planCode, interval, requestedTotalSeats);
  }

  async changePlan(tenantId: string, actorUserId: string, toPlanCode: string, interval?: 'month' | 'year', idempotencyKey?: string, requestedTotalSeats?: number, options: BillingCommandOptions = {}) {
    if (!options.bypassEntitlement) await this.entitlement.assertAction(tenantId, 'billing_recovery', actorUserId);
    const preview = await this.previewPlanChange(tenantId, toPlanCode, interval, requestedTotalSeats);
    const pending = await this.db.query(`SELECT id FROM tenant_billing_changes WHERE tenant_id = $1 AND status IN ('pending_payment', 'scheduled') LIMIT 1`, [tenantId]);
    if (pending.rows[0]) throw new ConflictException({ code: 'billing_change_in_progress', message: 'Já existe uma alteração de cobrança pendente.' });
    const subscription = await this.db.query(`SELECT ts.id, ts.stripe_subscription_id, ts.current_period_end FROM tenant_subscriptions ts WHERE ts.tenant_id = $1 AND ts.livemode = $2 AND ts.ended_at IS NULL ORDER BY ts.updated_at DESC LIMIT 1`, [tenantId, this.stripe.livemode]);
    if (!subscription.rows[0]) throw new ConflictException('Assinatura ativa não encontrada');
    const base = await this.db.query(`SELECT stripe_subscription_item_id FROM tenant_subscription_items WHERE tenant_subscription_id = $1 AND item_kind = 'base_plan' AND livemode = $2 LIMIT 1`, [subscription.rows[0].id, this.stripe.livemode]);
    const seat = await this.db.query(`SELECT stripe_subscription_item_id FROM tenant_subscription_items WHERE tenant_subscription_id = $1 AND item_kind = 'sdr_seat' AND livemode = $2 LIMIT 1`, [subscription.rows[0].id, this.stripe.livemode]);
    if (!base.rows[0]) throw new ConflictException('Item base não encontrado na assinatura');
    const key = idempotencyKey?.trim() || randomUUID();
    const changeId = randomUUID();
    const status = preview.effectiveAt === 'immediate' ? 'pending_payment' : 'scheduled';
    const effectiveAt = preview.effectiveAt === 'immediate' ? new Date() : (subscription.rows[0].current_period_end ?? null);
    if (status === 'scheduled' && !effectiveAt) throw new ConflictException('A assinatura não informa o fim do ciclo para agendar o downgrade');
    await this.db.query(`INSERT INTO tenant_billing_changes (id, tenant_id, stripe_subscription_id, change_type, from_plan_code, to_plan_code, from_seat_quantity, to_seat_quantity, to_plan_version_id, to_base_price_id, status, effective_at, idempotency_key, requested_by, requested_source, request_reason) VALUES ($1, $2, $3, 'plan_change', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`, [changeId, tenantId, subscription.rows[0].stripe_subscription_id, preview.currentPlanCode, preview.targetPlanCode, preview.currentTotalSeats, preview.targetTotalSeats, preview.targetPlanVersionId, preview.targetPriceId, status, effectiveAt, key, actorUserId, options.source ?? 'organization', options.reason?.trim() || null]);
    try {
      if (preview.effectiveAt === 'immediate') {
        await this.stripe.updateSubscriptionItem(String(base.rows[0].stripe_subscription_item_id), 1, `billing-plan:${tenantId}:${createHash('sha256').update(key).digest('hex')}`, String(preview.targetPriceId));
        const addon = preview.extraSeats > 0 ? await this.requireSeatAddon(preview.interval as 'month' | 'year') : null;
        if (seat.rows[0]) await this.stripe.updateSubscriptionItem(String(seat.rows[0].stripe_subscription_item_id), preview.extraSeats, `billing-plan-seat:${tenantId}:${createHash('sha256').update(key).digest('hex')}`, addon ? String(addon.stripe_price_id) : undefined);
        else if (addon) await this.stripe.createSubscriptionItem(String(subscription.rows[0].stripe_subscription_id), String(addon.stripe_price_id), preview.extraSeats, `billing-plan-seat:${tenantId}:${createHash('sha256').update(key).digest('hex')}`);
      }
    } catch (error) {
      await this.db.query(`UPDATE tenant_billing_changes SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [changeId, String(error).slice(0, 500)]).catch(() => undefined);
      throw error;
    }
    await this.audit.record({ actorUserId, tenantId, action: options.source === 'admin' ? 'admin.billing.plan_change_requested' : 'billing.plan_change_requested', entityType: 'tenant_billing_change', entityId: changeId, metadata: { ...preview, source: options.source ?? 'organization', reason: options.reason?.trim() || null } });
    return { changeId, ...preview, status };
  }

  private async requirePrice(planCode: string, interval: 'month' | 'year') {
    const result = await this.db.query(`
      SELECT pp.*, pv.code, pv.display_name, pv.max_sdrs, pv.included_sdrs, pv.sort_order, pv.limit_entitlements
      FROM billing_plan_prices pp
      JOIN billing_plan_versions pv ON pv.id = pp.plan_version_id
      WHERE pv.code = $1 AND pp.billing_interval = $2 AND pp.livemode = $3
        AND pp.active = true AND pv.status = 'active'
      ORDER BY pv.version DESC LIMIT 1
    `, [planCode.trim(), interval, this.stripe.livemode]);
    if (!result.rows[0]) throw new NotFoundException('Plano ou preço não encontrado para este ambiente');
    if (!Number(result.rows[0].max_sdrs)) throw new ConflictException('O plano ainda não possui limite de SDRs definido');
    if (!Number(result.rows[0].max_sdrs) || !Number(result.rows[0].included_sdrs)) throw new ConflictException('O plano ainda não possui limite de SDRs definido');
    return result.rows[0];
  }

  private async requireSeatAddon(interval: 'month' | 'year') {
    const result = await this.db.query(`SELECT * FROM billing_addon_prices WHERE addon_code = 'sdr_seat' AND billing_interval = $1 AND livemode = $2 AND active = true ORDER BY version DESC LIMIT 1`, [interval, this.stripe.livemode]);
    if (!result.rows[0]) throw new ConflictException('O adicional de SDR ainda não está configurado para este ambiente');
    return result.rows[0];
  }

  private async ensureCustomer(tenantId: string, actorUserId: string) {
    const result = await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-customer:${tenantId}:${this.stripe.livemode}`]);
      const existing = await client.query('SELECT stripe_customer_id FROM tenant_billing_accounts WHERE tenant_id = $1 AND livemode = $2', [tenantId, this.stripe.livemode]);
      if (existing.rows[0]) return { id: String(existing.rows[0].stripe_customer_id), created: false };
      const tenant = await client.query(`SELECT t.name, u.email FROM tenants t LEFT JOIN tenant_memberships tm ON tm.tenant_id = t.id AND tm.role = 'leader' AND tm.status = 'active' LEFT JOIN users u ON u.id = tm.user_id WHERE t.id = $1 ORDER BY tm.created_at LIMIT 1`, [tenantId]);
      if (!tenant.rows[0]) throw new NotFoundException('Empresa nao encontrada');
      // The lock deliberately spans the Stripe call: it prevents two API
      // instances from creating two Customers for the same tenant/mode.
      const customer = await this.stripe.createCustomer({ name: tenant.rows[0].name, email: tenant.rows[0].email ?? undefined, tenantId }, `billing-customer:${tenantId}:${this.stripe.livemode}`);
      await client.query(`INSERT INTO tenant_billing_accounts (tenant_id, stripe_customer_id, billing_email, livemode) VALUES ($1, $2, $3, $4)`, [tenantId, customer.id, tenant.rows[0].email ?? null, this.stripe.livemode]);
      return { id: customer.id, created: true };
    });
    if (result.created) await this.audit.record({ actorUserId, tenantId, action: 'billing.customer_created', entityType: 'stripe_customer', entityId: result.id });
    return result.id;
  }

  async createCheckoutSession(tenantId: string, actorUserId: string, input: { planCode: string; interval: 'month' | 'year'; totalSdrSeats?: number; successUrl?: string; cancelUrl?: string; idempotencyKey?: string; bypassEntitlement?: boolean; source?: 'organization' | 'admin'; reason?: string }) {
    if (!input.bypassEntitlement) await this.entitlement.assertAction(tenantId, 'billing_recovery', actorUserId);
    const price = await this.requirePrice(input.planCode, input.interval);
    const totalSdrSeats = Number.isInteger(input.totalSdrSeats) ? Number(input.totalSdrSeats) : Number(price.included_sdrs);
    if (totalSdrSeats < Number(price.included_sdrs) || totalSdrSeats > Number(price.max_sdrs)) throw new ConflictException(`Este plano permite entre ${price.included_sdrs} e ${price.max_sdrs} SDRs`);
    const customerId = await this.ensureCustomer(tenantId, actorUserId);
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '');
    // Checkout return URLs are server-owned. Never let a caller turn a
    // billing endpoint into an open redirect by supplying an arbitrary URL.
    const successUrl = `${origin}/app/cobranca?billing=success`;
    const cancelUrl = `${origin}/app/cobranca?billing=cancelled`;
    const existing = await this.db.query(`SELECT stripe_subscription_id, status FROM tenant_subscriptions WHERE tenant_id = $1 AND livemode = $2 AND ended_at IS NULL AND status NOT IN ('canceled', 'incomplete_expired') LIMIT 1`, [tenantId, this.stripe.livemode]);
    if (existing.rows[0]) throw new ConflictException('A organização já possui uma assinatura em andamento');
    const callerKey = input.idempotencyKey?.trim();
    const idempotencyKey = callerKey
      ? `billing-checkout:${tenantId}:${createHash('sha256').update(callerKey).digest('hex')}`
      : `billing-checkout:${tenantId}:${price.id}:${randomUUID()}`;
    const lineItems: Array<{ priceId: string; quantity: number }> = [{ priceId: String(price.stripe_price_id), quantity: 1 }];
    if (totalSdrSeats > Number(price.included_sdrs)) {
      const addon = await this.requireSeatAddon(input.interval);
      lineItems.push({ priceId: String(addon.stripe_price_id), quantity: totalSdrSeats - Number(price.included_sdrs) });
    }
    const session = await this.stripe.createCheckoutSession({ customerId, lineItems, tenantId, planCode: input.planCode, totalSdrSeats, successUrl, cancelUrl }, idempotencyKey);
    await this.audit.record({ actorUserId, tenantId, action: input.source === 'admin' ? 'admin.billing.checkout_created' : 'billing.checkout_created', entityType: 'checkout_session', entityId: session.id, metadata: { planCode: input.planCode, interval: input.interval, totalSdrSeats, source: input.source ?? 'organization', reason: input.reason?.trim() || null } });
    return { id: session.id, url: session.url, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null };
  }

  async createPortalSession(tenantId: string, actorUserId: string, returnUrl?: string, options: BillingCommandOptions = {}) {
    if (!options.bypassEntitlement) await this.entitlement.assertAction(tenantId, 'billing_recovery', actorUserId);
    const account = await this.db.query('SELECT stripe_customer_id FROM tenant_billing_accounts WHERE tenant_id = $1 AND livemode = $2', [tenantId, this.stripe.livemode]);
    if (!account.rows[0]) throw new ConflictException('A organização ainda não possui cadastro de cobrança');
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/$/, '');
    let safeReturnUrl = `${origin}/app/cobranca`;
    if (returnUrl) {
      try {
        const candidate = new URL(returnUrl, origin);
        if (candidate.origin === new URL(origin).origin) safeReturnUrl = candidate.toString();
      } catch { /* keep the server-owned fallback */ }
    }
    const session = await this.stripe.createPortalSession(String(account.rows[0].stripe_customer_id), safeReturnUrl);
    await this.audit.record({ actorUserId, tenantId, action: options.source === 'admin' ? 'admin.billing.portal_session_created' : 'billing.portal_session_created', entityType: 'billing_portal_session', metadata: { source: options.source ?? 'organization' } });
    return { url: session.url, expiresAt: session.created ? new Date((session.created + 3600) * 1000) : null };
  }

  async previewSeatChange(tenantId: string, targetTotalSeats: number) {
    const access = await this.entitlement.getAccess(tenantId);
    const target = Math.floor(Number(targetTotalSeats));
    const used = Number(access.usedSdrSeats ?? 0);
    const reserved = Number(access.reservedSdrSeats ?? 0);
    // The effective capacity is currently paid seats; a purchase may grow it
    // up to the commercial cap carried by the plan snapshot.
    if (access.planMaxSdrs != null) access.maxSdrs = access.planMaxSdrs;
    if (!Number.isInteger(target) || target < 1) throw new BadRequestException('Quantidade de SDRs inválida');
    if (access.includedSdrs == null || access.maxSdrs == null) throw new ConflictException('A organização ainda não possui um plano ativo');
    if (target < used + reserved) throw new ConflictException(`Não é possível reduzir abaixo de ${used + reserved} SDRs em uso ou convite pendente`);
    if (target > access.maxSdrs) throw new ConflictException(`O plano permite no máximo ${access.maxSdrs} SDRs`);
    const current = access.includedSdrs + Number(access.purchasedExtraSdrs ?? 0);
    return { currentTotalSeats: Math.max(current, used), targetTotalSeats: target, extraSeats: Math.max(0, target - access.includedSdrs), delta: target - current, effectiveAt: target < current ? 'period_end' as const : 'immediate' as const };
  }

  async changeSeats(tenantId: string, actorUserId: string, targetTotalSeats: number, idempotencyKey?: string, options: BillingCommandOptions = {}) {
    if (!options.bypassEntitlement) await this.entitlement.assertAction(tenantId, 'billing_recovery', actorUserId);
    const preview = await this.previewSeatChange(tenantId, targetTotalSeats);
    const pending = await this.db.query(`SELECT id FROM tenant_billing_changes WHERE tenant_id = $1 AND status IN ('pending_payment', 'scheduled') LIMIT 1`, [tenantId]);
    if (pending.rows[0]) throw new ConflictException({ code: 'billing_change_in_progress', message: 'Já existe uma alteração de cobrança pendente.' });
    const subscription = await this.db.query(`SELECT ts.id, ts.stripe_subscription_id, ts.current_period_end, pp.billing_interval FROM tenant_subscriptions ts LEFT JOIN billing_plan_prices pp ON pp.stripe_price_id = ts.stripe_price_id AND pp.livemode = ts.livemode WHERE ts.tenant_id = $1 AND ts.livemode = $2 AND ts.ended_at IS NULL ORDER BY ts.updated_at DESC LIMIT 1`, [tenantId, this.stripe.livemode]);
    if (!subscription.rows[0]) throw new ConflictException('Assinatura ativa não encontrada');
    const item = await this.db.query(`SELECT stripe_subscription_item_id FROM tenant_subscription_items WHERE tenant_subscription_id = $1 AND item_kind = 'sdr_seat' AND livemode = $2 LIMIT 1`, [subscription.rows[0].id, this.stripe.livemode]);
    const key = idempotencyKey?.trim() || randomUUID();
    const stripeKey = `billing-seats:${tenantId}:${createHash('sha256').update(key).digest('hex')}`;
    const changeId = randomUUID();
    const effectiveAt = preview.effectiveAt === 'period_end' ? (subscription.rows[0].current_period_end ?? null) : new Date();
    const changeStatus = preview.effectiveAt === 'immediate' ? 'pending_payment' : 'scheduled';
    if (changeStatus === 'scheduled' && !effectiveAt) throw new ConflictException('A assinatura não informa o fim do ciclo para agendar a redução de seats');
    await this.db.query(`INSERT INTO tenant_billing_changes (id, tenant_id, stripe_subscription_id, change_type, from_seat_quantity, to_seat_quantity, status, effective_at, idempotency_key, requested_by, requested_source, request_reason) VALUES ($1, $2, $3, 'seat_change', $4, $5, $6, $7, $8, $9, $10, $11)`, [changeId, tenantId, subscription.rows[0].stripe_subscription_id, preview.currentTotalSeats, preview.targetTotalSeats, changeStatus, effectiveAt, key, actorUserId, options.source ?? 'organization', options.reason?.trim() || null]);
    try {
    if (preview.effectiveAt === 'immediate') {
      if (item.rows[0]) await this.stripe.updateSubscriptionItem(String(item.rows[0].stripe_subscription_item_id), preview.extraSeats, stripeKey);
      else if (preview.extraSeats > 0) {
        if (!subscription.rows[0].billing_interval) throw new ConflictException('Não foi possível identificar o ciclo da assinatura');
        const addon = await this.requireSeatAddon(subscription.rows[0].billing_interval);
        await this.stripe.createSubscriptionItem(String(subscription.rows[0].stripe_subscription_id), String(addon.stripe_price_id), preview.extraSeats, stripeKey);
      }
    }
    } catch (error) {
      await this.db.query(`UPDATE tenant_billing_changes SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [changeId, String(error).slice(0, 500)]).catch(() => undefined);
      throw error;
    }
    await this.audit.record({ actorUserId, tenantId, action: options.source === 'admin' ? 'admin.billing.seats_change_requested' : 'billing.seats_change_requested', entityType: 'tenant_billing_change', entityId: changeId, metadata: { ...preview, source: options.source ?? 'organization', reason: options.reason?.trim() || null } });
    return { changeId, ...preview, status: preview.effectiveAt === 'immediate' ? 'pending_payment' : 'scheduled' };
  }

  async applyScheduledSeatChanges(limit = 25) {
    const changes = await this.db.query(`SELECT id, tenant_id, stripe_subscription_id, to_seat_quantity FROM tenant_billing_changes WHERE change_type = 'seat_change' AND status = 'scheduled' AND effective_at <= now() ORDER BY effective_at LIMIT $1`, [Math.min(100, Math.max(1, limit))]);
    const results: Array<{ id: string; ok: boolean }> = [];
    for (const change of changes.rows) {
      try {
        const item = await this.db.query(`SELECT tsi.stripe_subscription_item_id FROM tenant_subscription_items tsi JOIN tenant_subscriptions ts ON ts.id = tsi.tenant_subscription_id WHERE ts.stripe_subscription_id = $1 AND tsi.item_kind = 'sdr_seat' AND tsi.livemode = $2 LIMIT 1`, [change.stripe_subscription_id, this.stripe.livemode]);
        if (item.rows[0]) await this.stripe.updateSubscriptionItem(String(item.rows[0].stripe_subscription_item_id), Math.max(0, Number(change.to_seat_quantity)), `billing-scheduled-seat:${change.id}`, undefined, 'none');
        await this.db.query(`UPDATE tenant_billing_changes SET status = 'pending_payment', updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [change.id]);
        results.push({ id: String(change.id), ok: true });
      } catch (error) {
        await this.db.query(`UPDATE tenant_billing_changes SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [change.id, String(error).slice(0, 500)]).catch(() => undefined);
        results.push({ id: String(change.id), ok: false });
      }
    }
    return results;
  }

  async applyScheduledPlanChanges(limit = 25) {
    const changes = await this.db.query(`SELECT id, tenant_id, stripe_subscription_id, to_base_price_id, to_seat_quantity, to_plan_version_id FROM tenant_billing_changes WHERE change_type = 'plan_change' AND status = 'scheduled' AND effective_at <= now() ORDER BY effective_at LIMIT $1`, [Math.min(100, Math.max(1, limit))]);
    const results: Array<{ id: string; ok: boolean }> = [];
    for (const change of changes.rows) {
      try {
        const usage = await this.db.query(`SELECT (SELECT count(*)::int FROM tenant_memberships WHERE tenant_id = $1 AND role = 'sdr' AND status = 'active') + (SELECT count(*)::int FROM invitations WHERE tenant_id = $1 AND role = 'sdr' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS used_reserved`, [change.tenant_id]);
        if (Number(usage.rows[0]?.used_reserved ?? 0) > Number(change.to_seat_quantity ?? 0)) {
          await this.db.query(`UPDATE tenant_billing_changes SET status = 'canceled', error_code = 'seat_usage_changed', error_message = 'Uso de SDRs excede o plano desejado', updated_at = now() WHERE id = $1`, [change.id]);
          results.push({ id: String(change.id), ok: false });
          continue;
        }
        const subscription = await this.db.query(`SELECT id FROM tenant_subscriptions WHERE stripe_subscription_id = $1 AND livemode = $2 LIMIT 1`, [change.stripe_subscription_id, this.stripe.livemode]);
        const base = await this.db.query(`SELECT stripe_subscription_item_id FROM tenant_subscription_items WHERE tenant_subscription_id = $1 AND item_kind = 'base_plan' AND livemode = $2 LIMIT 1`, [subscription.rows[0]?.id, this.stripe.livemode]);
        if (!base.rows[0]) throw new Error('Item base não encontrado');
        await this.stripe.updateSubscriptionItem(String(base.rows[0].stripe_subscription_item_id), 1, `billing-scheduled-plan:${change.id}`, String(change.to_base_price_id), 'none');
        const target = await this.db.query(`SELECT pv.included_sdrs, pp.billing_interval FROM billing_plan_versions pv JOIN billing_plan_prices pp ON pp.plan_version_id = pv.id WHERE pv.id = $1 AND pp.livemode = $2 LIMIT 1`, [change.to_plan_version_id, this.stripe.livemode]);
        const extra = Math.max(0, Number(change.to_seat_quantity ?? 0) - Number(target.rows[0]?.included_sdrs ?? 0));
        const seat = await this.db.query(`SELECT stripe_subscription_item_id FROM tenant_subscription_items WHERE tenant_subscription_id = $1 AND item_kind = 'sdr_seat' AND livemode = $2 LIMIT 1`, [subscription.rows[0]?.id, this.stripe.livemode]);
        if (seat.rows[0]) await this.stripe.updateSubscriptionItem(String(seat.rows[0].stripe_subscription_item_id), extra, `billing-scheduled-plan-seat:${change.id}`, undefined, 'none');
        else if (extra > 0) {
          const addon = await this.requireSeatAddon(target.rows[0]?.billing_interval ?? 'month');
          await this.stripe.createSubscriptionItem(String(change.stripe_subscription_id), String(addon.stripe_price_id), extra, `billing-scheduled-plan-seat:${change.id}`, 'none');
        }
        await this.db.query(`UPDATE tenant_billing_changes SET status = 'pending_payment', updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [change.id]);
        results.push({ id: String(change.id), ok: true });
      } catch (error) {
        await this.db.query(`UPDATE tenant_billing_changes SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [change.id, String(error).slice(0, 500)]).catch(() => undefined);
        results.push({ id: String(change.id), ok: false });
      }
    }
    return results;
  }

  async cancelPendingChange(tenantId: string, changeId: string, actorUserId: string, options: BillingCommandOptions = {}) {
    const result = await this.db.query(`UPDATE tenant_billing_changes SET status = 'canceled', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled' RETURNING id, change_type`, [changeId, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Alteração pendente não encontrada ou já aplicada');
    await this.audit.record({ actorUserId, tenantId, action: options.source === 'admin' ? 'admin.billing.change_canceled' : 'billing.change_canceled', entityType: 'tenant_billing_change', entityId: changeId, metadata: { changeType: result.rows[0].change_type, source: options.source ?? 'organization' } });
    return { ok: true, id: changeId };
  }

  createManualGrant(tenantId: string, input: { startsAt: Date; expiresAt: Date; maxSdrs: number; reason: string; actorUserId: string }) {
    return this.entitlement.createManualGrant(tenantId, input);
  }

  revokeManualGrant(tenantId: string, grantId: string, actorUserId: string) {
    return this.entitlement.revokeManualGrant(tenantId, grantId, actorUserId);
  }

  createOverride(tenantId: string, input: { featureCode?: string; overrideMode: 'grant' | 'deny' | 'replace_limit'; value?: Record<string, unknown>; reason: string; expiresInSeconds?: number; actorUserId: string }) {
    return this.entitlement.createOverride(tenantId, input);
  }

  revokeOverride(tenantId: string, id: string, actorUserId: string) {
    return this.entitlement.revokeOverride(tenantId, id, actorUserId);
  }

  async recordWebhook(event: any) {
    if (!event?.id || !event?.type) throw new BadRequestException('Evento Stripe incompleto');
    if (Boolean(event.livemode) !== this.stripe.livemode) throw new BadRequestException('Evento Stripe pertence a outro ambiente');
    const object = event?.data?.object ?? {};
    const objectId = typeof object.id === 'string' ? object.id : null;
    const result = await this.db.query(`
      INSERT INTO billing_webhook_events (stripe_event_id, event_type, object_id, livemode, api_version, payload)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id
    `, [String(event.id), String(event.type), objectId, Boolean(event.livemode), event.api_version ?? null, JSON.stringify(event)]);
    return { accepted: true, duplicate: result.rows.length === 0 };
  }

  private subscriptionIdFromInvoice(invoice: any) {
    return String(invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? '').trim() || null;
  }

  private async tenantForCustomer(customerId: string, metadataTenantId?: string, allowMetadataAssociation = false) {
    const account = await this.db.query('SELECT tenant_id FROM tenant_billing_accounts WHERE stripe_customer_id = $1 AND livemode = $2 LIMIT 1', [customerId, this.stripe.livemode]);
    if (account.rows[0]) {
      if (metadataTenantId && String(account.rows[0].tenant_id) !== String(metadataTenantId)) throw new Error(`Stripe customer associado a outro tenant: ${customerId}`);
      return String(account.rows[0].tenant_id);
    }
    // Only our signed Checkout completion may establish the first association.
    // Subscription/invoice events for an unknown customer go to dead-letter
    // instead of allowing arbitrary Stripe metadata to create a tenant link.
    if (!allowMetadataAssociation || !metadataTenantId) return null;
    const tenant = await this.db.query('SELECT id FROM tenants WHERE id = $1 LIMIT 1', [metadataTenantId]);
    if (!tenant.rows[0]) return null;
    await this.db.query(`INSERT INTO tenant_billing_accounts (tenant_id, stripe_customer_id, livemode) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, livemode) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = now()`, [metadataTenantId, customerId, this.stripe.livemode]);
    return metadataTenantId;
  }

  private async syncSubscription(subscription: any, event: any, invoicePaid = false) {
    const customerId = String(subscription.customer ?? '').trim();
    const tenantId = await this.tenantForCustomer(customerId, subscription.metadata?.tenant_id);
    if (!tenantId) throw new Error(`Stripe customer sem tenant associado: ${customerId}`);
    const before = await this.entitlement.getAccess(tenantId).catch(() => null);
    const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
    const catalog = items.length ? await this.db.query(`SELECT stripe_price_id FROM billing_plan_prices WHERE livemode = $1 AND active = true AND stripe_price_id = ANY($2::text[])`, [this.stripe.livemode, items.map((item: any) => String(item?.price?.id ?? item?.plan?.id ?? '').trim()).filter(Boolean)]) : { rows: [] };
    const basePriceIds = new Set(catalog.rows.map((row: any) => String(row.stripe_price_id)));
    const baseItems = items.filter((item: any) => basePriceIds.has(String(item?.price?.id ?? item?.plan?.id ?? '').trim()));
    if (baseItems.length > 1) throw new Error('Assinatura Stripe possui mais de um preço-base');
    const baseItem = baseItems[0];
    const priceId = String(baseItem?.price?.id ?? baseItem?.plan?.id ?? '').trim() || null;
    if (items.length && !priceId) throw new Error('Assinatura Stripe sem preço-base cadastrado');
    const price = priceId ? await this.db.query(`SELECT pp.plan_version_id, pv.code, pv.display_name, pv.max_sdrs, pv.included_sdrs, pv.feature_entitlements, pv.limit_entitlements FROM billing_plan_prices pp JOIN billing_plan_versions pv ON pv.id = pp.plan_version_id WHERE pp.stripe_price_id = $1 AND pp.livemode = $2 LIMIT 1`, [priceId, this.stripe.livemode]) : { rows: [] };
    if (priceId && !price.rows[0]) throw new Error(`Preço base Stripe não cadastrado: ${priceId}`);
    const currentStart = asDate(subscription.current_period_start);
    const currentEnd = asDate(subscription.current_period_end);
    const trialEnd = asDate(subscription.trial_end);
    const providerUpdatedAt = asDate(event.created) ?? new Date();
    const subscriptionDeleted = event.type === 'customer.subscription.deleted';
    const existing = await this.db.query('SELECT id, access_until, stripe_price_id, plan_version_id FROM tenant_subscriptions WHERE stripe_subscription_id = $1 AND livemode = $2 LIMIT 1', [String(subscription.id), this.stripe.livemode]);
    const subscriptionRowId = existing.rows[0]?.id ?? randomUUID();
    const effectivePriceId = subscriptionDeleted ? null : (invoicePaid || !existing.rows[0] ? priceId : existing.rows[0].stripe_price_id);
    const effectivePlanVersionId = subscriptionDeleted ? null : (invoicePaid || !existing.rows[0] ? (price.rows[0]?.plan_version_id ?? null) : existing.rows[0].plan_version_id);
    const existingAccess = existing.rows[0]?.access_until ? new Date(existing.rows[0].access_until) : null;
    const accessUntil = subscriptionDeleted ? null : (invoicePaid ? currentEnd : (String(subscription.status) === 'trialing' ? (trialEnd ?? currentEnd) : existingAccess));
    await this.db.transaction(async (client) => {
      await client.query(`
        INSERT INTO tenant_subscriptions (id, tenant_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, plan_version_id, status, livemode, current_period_start, current_period_end, trial_end, cancel_at_period_end, canceled_at, ended_at, latest_invoice_id, latest_invoice_status, access_until, last_provider_event_id, provider_updated_at, last_synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
        ON CONFLICT (stripe_subscription_id, livemode) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_price_id = EXCLUDED.stripe_price_id, plan_version_id = EXCLUDED.plan_version_id, status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end, trial_end = EXCLUDED.trial_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, canceled_at = EXCLUDED.canceled_at, ended_at = EXCLUDED.ended_at, latest_invoice_id = COALESCE(EXCLUDED.latest_invoice_id, tenant_subscriptions.latest_invoice_id), latest_invoice_status = COALESCE(EXCLUDED.latest_invoice_status, tenant_subscriptions.latest_invoice_status), access_until = CASE WHEN EXCLUDED.ended_at IS NOT NULL THEN NULL ELSE COALESCE(EXCLUDED.access_until, tenant_subscriptions.access_until) END, last_provider_event_id = EXCLUDED.last_provider_event_id, provider_updated_at = EXCLUDED.provider_updated_at, last_synced_at = now(), updated_at = now()
        WHERE tenant_subscriptions.provider_updated_at IS NULL OR EXCLUDED.provider_updated_at >= tenant_subscriptions.provider_updated_at
      `, [subscriptionRowId, tenantId, String(subscription.id), customerId, effectivePriceId, effectivePlanVersionId, String(subscription.status), this.stripe.livemode, currentStart, currentEnd, trialEnd, Boolean(subscription.cancel_at_period_end), asDate(subscription.canceled_at), subscriptionDeleted ? new Date() : asDate(subscription.ended_at), typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice?.id ?? null, event.type.startsWith('invoice.') ? event.type.slice('invoice.'.length) : null, accessUntil, String(event.id), providerUpdatedAt]);
      await client.query(`UPDATE tenant_subscription_items SET quantity = 0, pending_quantity = NULL, updated_at = now() WHERE tenant_subscription_id = $1 AND livemode = $2 AND (provider_updated_at IS NULL OR provider_updated_at <= $4) AND NOT (stripe_subscription_item_id = ANY($3::text[]))`, [subscriptionRowId, this.stripe.livemode, items.map((item: any) => String(item.id)), providerUpdatedAt]);
      for (const item of items) {
        const itemPriceId = String(item?.price?.id ?? item?.plan?.id ?? '').trim();
        if (!itemPriceId) continue;
        const isBase = itemPriceId === priceId;
        const addon = !isBase ? await client.query(`SELECT id FROM billing_addon_prices WHERE stripe_price_id = $1 AND livemode = $2 AND addon_code = 'sdr_seat' LIMIT 1`, [itemPriceId, this.stripe.livemode]) : { rows: [] };
        if (!isBase && !addon.rows[0]) throw new Error(`Preço de item Stripe não cadastrado: ${itemPriceId}`);
        const kind = isBase ? 'base_plan' : (addon.rows[0] ? 'sdr_seat' : 'other');
        await client.query(`
          INSERT INTO tenant_subscription_items (id, tenant_subscription_id, stripe_subscription_item_id, stripe_price_id, item_kind, plan_version_id, addon_price_id, quantity, pending_quantity, livemode, provider_updated_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $11::boolean OR $5 <> 'sdr_seat' THEN $8 ELSE 0 END, CASE WHEN $11::boolean THEN NULL ELSE $8 END, $9, $10, now())
          ON CONFLICT (stripe_subscription_item_id, livemode) DO UPDATE SET tenant_subscription_id = EXCLUDED.tenant_subscription_id, stripe_price_id = CASE WHEN $11::boolean OR EXCLUDED.item_kind <> 'base_plan' THEN EXCLUDED.stripe_price_id ELSE tenant_subscription_items.stripe_price_id END, item_kind = EXCLUDED.item_kind, plan_version_id = CASE WHEN $11::boolean OR EXCLUDED.item_kind <> 'base_plan' THEN EXCLUDED.plan_version_id ELSE tenant_subscription_items.plan_version_id END, addon_price_id = EXCLUDED.addon_price_id, quantity = CASE WHEN $11::boolean THEN EXCLUDED.quantity ELSE tenant_subscription_items.quantity END, pending_quantity = CASE WHEN $11::boolean THEN NULL ELSE CASE WHEN EXCLUDED.item_kind = 'sdr_seat' AND EXCLUDED.quantity <> tenant_subscription_items.quantity THEN EXCLUDED.quantity ELSE tenant_subscription_items.pending_quantity END END, provider_updated_at = EXCLUDED.provider_updated_at, updated_at = now()
          WHERE tenant_subscription_items.provider_updated_at IS NULL OR EXCLUDED.provider_updated_at >= tenant_subscription_items.provider_updated_at
        `, [randomUUID(), subscriptionRowId, String(item.id), itemPriceId, kind, isBase ? (price.rows[0]?.plan_version_id ?? null) : null, addon.rows[0]?.id ?? null, Math.max(0, Number(item.quantity ?? 0)), this.stripe.livemode, providerUpdatedAt, invoicePaid]);
      }
      if (invoicePaid) await client.query(`UPDATE tenant_billing_changes SET status = 'applied', updated_at = now() WHERE tenant_id = $1 AND stripe_subscription_id = $2 AND status = 'pending_payment'`, [tenantId, String(subscription.id)]);
      if (subscriptionDeleted) await client.query(`UPDATE tenant_billing_changes SET status = 'canceled', error_code = 'subscription_deleted', updated_at = now() WHERE tenant_id = $1 AND stripe_subscription_id = $2 AND status IN ('pending_payment', 'scheduled')`, [tenantId, String(subscription.id)]);
      await this.entitlement.recompute(tenantId, client);
    });
    const action = invoicePaid ? 'billing.invoice_paid' : event.type === 'invoice.payment_failed' ? 'billing.payment_failed' : 'billing.subscription_changed';
    await this.audit.record({ tenantId, action, entityType: 'stripe_subscription', entityId: String(subscription.id), metadata: { status: subscription.status, priceId, eventType: event.type } });
    const after = await this.entitlement.getAccess(tenantId);
    if (after.mode === 'full' && before?.mode !== 'full') await this.audit.record({ tenantId, action: 'billing.plan_activated', entityType: 'tenant_entitlement', entityId: tenantId, metadata: { planCode: after.planCode, maxSdrs: after.maxSdrs } });
    if (before && JSON.stringify(before.featureEntitlements ?? {}) !== JSON.stringify(after.featureEntitlements ?? {})) await this.audit.record({ tenantId, action: 'billing.feature_entitlements_changed', entityType: 'tenant_entitlement', entityId: tenantId, metadata: { planCode: after.planCode } });
    if (before && JSON.stringify(before.limitEntitlements ?? {}) !== JSON.stringify(after.limitEntitlements ?? {})) await this.audit.record({ tenantId, action: 'billing.limit_entitlements_changed', entityType: 'tenant_entitlement', entityId: tenantId, metadata: { planCode: after.planCode } });
    if (!before || before.mode !== after.mode || before.reason !== after.reason || before.planCode !== after.planCode || before.maxSdrs !== after.maxSdrs) {
      await this.audit.record({ tenantId, action: 'billing.access_changed', entityType: 'tenant_entitlement', entityId: tenantId, metadata: { before: before ? { mode: before.mode, reason: before.reason, planCode: before.planCode, maxSdrs: before.maxSdrs } : null, after: { mode: after.mode, reason: after.reason, planCode: after.planCode, maxSdrs: after.maxSdrs } } });
    }
    return tenantId;
  }

  async processWebhookEvent(eventId: string) {
    // Claim the inbox row atomically so multiple API instances/workers cannot
    // apply the same event concurrently. The unique Stripe event id remains
    // the idempotency key even when a delivery is retried.
    const claim = await this.db.query(`
      UPDATE billing_webhook_events
      SET status = 'processing', attempts = attempts + 1, claimed_at = now()
      WHERE stripe_event_id = $1
        AND next_attempt_at <= now()
        AND (status IN ('received', 'failed') OR (status = 'processing' AND COALESCE(claimed_at, received_at) < now() - interval '10 minutes'))
      RETURNING payload, attempts
    `, [eventId]);
    if (!claim.rows[0]) {
      const current = await this.db.query('SELECT status FROM billing_webhook_events WHERE stripe_event_id = $1 LIMIT 1', [eventId]);
      if (!current.rows[0]) throw new NotFoundException('Evento Stripe não encontrado');
      return { processed: current.rows[0].status === 'processed', duplicate: true, status: current.rows[0].status };
    }
    const event = claim.rows[0].payload;
    try {
      const object = event.data?.object ?? {};
      if (event.type === 'checkout.session.completed') {
        const tenantId = await this.tenantForCustomer(String(object.customer ?? ''), object.client_reference_id ?? object.metadata?.tenant_id, true);
        if (tenantId && object.subscription && this.stripe.configured) await this.syncSubscription(await this.stripe.retrieveSubscription(String(object.subscription)), event, false);
      } else if (event.type.startsWith('customer.subscription.')) {
        await this.syncSubscription(object, event, event.type === 'customer.subscription.pending_update_applied');
      } else if (event.type.startsWith('invoice.')) {
        const subscriptionId = this.subscriptionIdFromInvoice(object);
        if (subscriptionId && this.stripe.configured) await this.syncSubscription(await this.stripe.retrieveSubscription(subscriptionId), event, event.type === 'invoice.paid');
      }
      await this.db.query('UPDATE billing_webhook_events SET status = \'processed\', processed_at = now(), claimed_at = NULL, last_error = NULL WHERE stripe_event_id = $1', [eventId]);
      return { processed: true };
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
      await this.db.query(`UPDATE billing_webhook_events SET status = CASE WHEN attempts >= 8 THEN 'dead_letter' ELSE 'failed' END, claimed_at = NULL, last_error = $2, next_attempt_at = now() + (LEAST(attempts, 8) * interval '1 minute') WHERE stripe_event_id = $1`, [eventId, message]);
      this.logger.error(`Falha ao processar webhook ${eventId}: ${message}`);
      throw error;
    }
  }

  async processPendingWebhooks(limit = 25) {
    const pending = await this.db.query(`SELECT stripe_event_id FROM billing_webhook_events WHERE next_attempt_at <= now() AND (status IN ('received', 'failed') OR (status = 'processing' AND COALESCE(claimed_at, received_at) < now() - interval '10 minutes')) ORDER BY received_at LIMIT $1`, [Math.min(100, Math.max(1, limit))]);
    const results: Array<{ id: string; ok: boolean }> = [];
    for (const row of pending.rows) {
      try { await this.processWebhookEvent(String(row.stripe_event_id)); results.push({ id: row.stripe_event_id, ok: true }); }
      catch { results.push({ id: row.stripe_event_id, ok: false }); }
    }
    return results;
  }

  async listWebhookEvents(limit = 100, status?: string) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const values: unknown[] = [safeLimit];
    const statusClause = status && ['received', 'processing', 'processed', 'failed', 'dead_letter'].includes(status)
      ? (values.push(status), 'WHERE status = $2')
      : '';
    const result = await this.db.query(`
      SELECT stripe_event_id, event_type, object_id, livemode, status, received_at,
        processed_at, claimed_at, attempts, next_attempt_at, last_error
      FROM billing_webhook_events
      ${statusClause}
      ORDER BY received_at DESC
      LIMIT $1
    `, values);
    return result.rows;
  }

  async retryWebhookEvent(eventId: string, actorUserId: string) {
    const result = await this.db.query(`
      UPDATE billing_webhook_events
      SET status = 'received', attempts = 0, claimed_at = NULL, processed_at = NULL,
        next_attempt_at = now(), last_error = NULL
      WHERE stripe_event_id = $1 AND status = 'dead_letter'
      RETURNING stripe_event_id
    `, [eventId]);
    if (!result.rows[0]) throw new NotFoundException('Evento morto não encontrado');
    await this.audit.record({ actorUserId, action: 'billing.webhook_requeued', entityType: 'billing_webhook_event', entityId: eventId });
    return { queued: true, eventId };
  }

  async reconcileTenant(tenantId: string) {
    if (!this.stripe.configured) throw new ServiceUnavailableException({ code: 'stripe_not_configured', message: 'Stripe não configurado' });
    const account = await this.db.query('SELECT stripe_customer_id FROM tenant_billing_accounts WHERE tenant_id = $1 AND livemode = $2 LIMIT 1', [tenantId, this.stripe.livemode]);
    if (!account.rows[0]) {
      await this.entitlement.recompute(tenantId);
      return this.entitlement.getAccess(tenantId);
    }
    const subs = await this.db.query('SELECT stripe_subscription_id FROM tenant_subscriptions WHERE tenant_id = $1 AND livemode = $2 AND ended_at IS NULL', [tenantId, this.stripe.livemode]);
    for (const row of subs.rows) await this.syncSubscription(await this.stripe.retrieveSubscription(String(row.stripe_subscription_id)), { id: `reconcile:${Date.now()}`, type: 'billing.reconcile' }, false);
    if (!subs.rows.length) await this.entitlement.recompute(tenantId);
    await this.db.query('UPDATE tenant_billing_accounts SET last_reconciled_at = now(), updated_at = now() WHERE tenant_id = $1 AND livemode = $2', [tenantId, this.stripe.livemode]);
    await this.audit.record({ tenantId, action: 'billing.reconciled', entityType: 'tenant', entityId: tenantId });
    return this.entitlement.getAccess(tenantId);
  }

  async reconcileStaleTenants(limit = 5) {
    if (!this.stripe.configured) return [];
    const staleSeconds = Math.max(60, Math.floor(Number(process.env.BILLING_STALE_AFTER_MS ?? 1_800_000) / 1000));
    const candidates = await this.db.query(`
      SELECT tenant_id
      FROM tenant_billing_accounts
      WHERE livemode = $1 AND (last_reconciled_at IS NULL OR last_reconciled_at < now() - ($2::int * interval '1 second'))
      ORDER BY last_reconciled_at NULLS FIRST
      LIMIT $3
    `, [this.stripe.livemode, staleSeconds, Math.min(25, Math.max(1, limit))]);
    const results: Array<{ tenantId: string; ok: boolean }> = [];
    for (const row of candidates.rows) {
      const tenantId = String(row.tenant_id);
      try { await this.reconcileTenant(tenantId); results.push({ tenantId, ok: true }); }
      catch (error) {
        this.logger.warn(`Falha ao reconciliar billing tenant=${tenantId}: ${String(error)}`);
        await this.audit.record({ tenantId, action: 'billing.reconcile_failed', entityType: 'tenant', entityId: tenantId, metadata: { error: String(error).slice(0, 300) } }).catch(() => undefined);
        results.push({ tenantId, ok: false });
      }
    }
    return results;
  }
}
