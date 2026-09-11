import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';

/** Thin boundary around Stripe so the domain can be tested without the network. */
@Injectable()
export class StripeClientService {
  private readonly stripe?: Stripe;
  readonly livemode = String(process.env.STRIPE_LIVEMODE ?? 'false').toLowerCase() === 'true';

  constructor() {
    const secret = process.env.STRIPE_SECRET_KEY?.trim();
    const enforcement = String(process.env.BILLING_ENFORCEMENT_MODE ?? 'enforce').toLowerCase();
    const productionBilling = process.env.NODE_ENV === 'production' && enforcement !== 'off';
    if (productionBilling && (!secret || !process.env.STRIPE_WEBHOOK_SECRET?.trim() || !process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim())) {
      throw new Error('Stripe secret, webhook secret and portal configuration are required when billing is active in production');
    }
    if (productionBilling && !this.livemode) {
      throw new Error('STRIPE_LIVEMODE=true is required when billing is active in production');
    }
    const keyIsLive = Boolean(secret && /^(sk|rk)_live_/.test(secret));
    const keyIsTest = Boolean(secret && /^(sk|rk)_test_/.test(secret));
    if (productionBilling && (keyIsLive || keyIsTest) && keyIsLive !== this.livemode) {
      throw new Error('STRIPE_LIVEMODE does not match the supplied Stripe secret key');
    }
    if (secret) {
      const apiVersion = process.env.STRIPE_API_VERSION?.trim();
      this.stripe = new Stripe(secret, apiVersion ? { apiVersion: apiVersion as any } : undefined);
    }
  }

  get configured() { return Boolean(this.stripe); }

  private requireClient() {
    if (!this.stripe) throw new ServiceUnavailableException({ code: 'stripe_not_configured', message: 'A cobrança ainda não está configurada.' });
    return this.stripe;
  }

  constructEvent(rawBody: Buffer | string, signature: string | undefined) {
    if (!signature) throw new Error('Stripe-Signature ausente');
    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET ausente');
    return this.requireClient().webhooks.constructEvent(rawBody, signature, secret);
  }

  createCustomer(input: { name: string; email?: string; tenantId: string }, idempotencyKey: string) {
    return this.requireClient().customers.create({
      name: input.name,
      email: input.email,
      metadata: { tenant_id: input.tenantId },
    }, { idempotencyKey });
  }

  createCheckoutSession(input: {
    customerId: string;
    lineItems: Array<{ priceId: string; quantity: number }>;
    tenantId: string;
    planCode?: string;
    totalSdrSeats?: number;
    successUrl: string;
    cancelUrl: string;
  }, idempotencyKey: string) {
    return this.requireClient().checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      line_items: input.lineItems.map((line) => ({ price: line.priceId, quantity: line.quantity })),
      client_reference_id: input.tenantId,
      metadata: { tenant_id: input.tenantId, ...(input.planCode ? { plan_code: input.planCode } : {}), ...(input.totalSdrSeats != null ? { total_sdr_seats: String(input.totalSdrSeats) } : {}) },
      subscription_data: { metadata: { tenant_id: input.tenantId, ...(input.planCode ? { plan_code: input.planCode } : {}), ...(input.totalSdrSeats != null ? { total_sdr_seats: String(input.totalSdrSeats) } : {}) } },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }, { idempotencyKey });
  }

  createPortalSession(customerId: string, returnUrl: string) {
    const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
    if (process.env.NODE_ENV === 'production' && !configuration) {
      throw new ServiceUnavailableException({ code: 'stripe_portal_not_configured', message: 'Configure o portal Stripe antes de liberar o gerenciamento de cobrança.' });
    }
    return this.requireClient().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl, ...(configuration ? { configuration } : {}) });
  }

  retrieveSubscription(subscriptionId: string) {
    return this.requireClient().subscriptions.retrieve(subscriptionId);
  }

  updateSubscriptionItem(subscriptionItemId: string, quantity: number, idempotencyKey: string, priceId?: string, prorationBehavior: 'always_invoice' | 'none' = 'always_invoice') {
    return this.requireClient().subscriptionItems.update(subscriptionItemId, {
      quantity,
      ...(priceId ? { price: priceId } : {}),
      proration_behavior: prorationBehavior,
    }, { idempotencyKey });
  }

  createSubscriptionItem(subscriptionId: string, priceId: string, quantity: number, idempotencyKey: string, prorationBehavior: 'always_invoice' | 'none' = 'always_invoice') {
    return this.requireClient().subscriptionItems.create({ subscription: subscriptionId, price: priceId, quantity, proration_behavior: prorationBehavior }, { idempotencyKey });
  }
}
