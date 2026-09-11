import 'dotenv/config';
import Stripe from 'stripe';
import { Pool } from 'pg';

type Plan = { code: string; productName: string; description: string; sortOrder: number; maxSdrs: number; includedSdrs: number; monthly: number; yearly: number; features: Record<string, string>; limits: Record<string, number> };

const plans: Plan[] = [
  { code: 'starter', productName: 'ZapLiga Starter', description: 'Para equipes pequenas', sortOrder: 10, maxSdrs: 14, includedSdrs: 5, monthly: 8990, yearly: 89900, features: { schedule_enforcement: 'full', callbacks: 'full', privacy_requests: 'full', onboarding: 'full', operation_health: 'basic' }, limits: { numbers: 3, leads: 25_000, retention_days: 90, max_concurrent_dialers: 1 } },
  { code: 'growth', productName: 'ZapLiga Growth', description: 'Para operações em crescimento', sortOrder: 20, maxSdrs: 39, includedSdrs: 15, monthly: 24_990, yearly: 249_900, features: { schedule_enforcement: 'full', callbacks: 'full', privacy_requests: 'full', onboarding: 'full', campaigns: 'full', decision_engine: 'full', recommendations: 'full', operation_health: 'full', lead_ingestion_api: 'full', advanced_reports: 'basic' }, limits: { numbers: 10, leads: 250_000, retention_days: 365, max_concurrent_dialers: 3 } },
  { code: 'pro', productName: 'ZapLiga Pro', description: 'Para operações avançadas', sortOrder: 30, maxSdrs: 99, includedSdrs: 40, monthly: 59_990, yearly: 599_900, features: { schedule_enforcement: 'full', callbacks: 'full', privacy_requests: 'full', onboarding: 'full', campaigns: 'full', decision_engine: 'full', recommendations: 'full', operation_health: 'full', analytics_learning: 'full', experiments: 'full', benchmarks: 'full', lead_ingestion_api: 'full', advanced_reports: 'full' }, limits: { numbers: 30, leads: 1_000_000, retention_days: 730, max_concurrent_dialers: 5 } },
];

// Keep catalog-facing copy ASCII-safe even when this script is executed from
// a Windows shell with a legacy code page.
const catalogPlans = plans.map((plan) => ({
  ...plan,
  description: plan.code === 'growth' ? 'Para operacoes em crescimento' : plan.code === 'pro' ? 'Para operacoes avancadas' : plan.description,
}));

const livemode = String(process.env.STRIPE_LIVEMODE ?? 'false').toLowerCase() === 'true';
const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is required');
const keyIsLive = /^(sk|rk)_live_/.test(stripeKey);
const keyIsTest = /^(sk|rk)_test_/.test(stripeKey);
if ((keyIsLive || keyIsTest) && keyIsLive !== livemode) throw new Error(`STRIPE_LIVEMODE=${livemode} does not match the supplied Stripe key`);
const stripe = new Stripe(stripeKey, { apiVersion: (process.env.STRIPE_API_VERSION ?? '2025-06-30.basil') as any });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function findOrCreateProduct(code: string, name: string, description: string) {
  const products = await stripe.products.list({ limit: 100, active: true });
  // Products created manually in Dashboard may already have the stable
  // zapliga_code but not the catalog/version metadata. Reuse them by code and
  // backfill the canonical metadata instead of creating a duplicate product.
  const existing = products.data.find((product) => product.metadata?.zapliga_code === code && (product.metadata?.zapliga_catalog === '2026-09' || product.name === name));
  if (existing) {
    const metadata = { ...existing.metadata, zapliga_code: code, zapliga_catalog: '2026-09', zapliga_kind: code === 'sdr_seat' ? 'sdr_seat' : 'base_plan', zapliga_plan_version: '1' };
    if (existing.metadata?.zapliga_catalog !== '2026-09' || existing.metadata?.zapliga_kind !== metadata.zapliga_kind || existing.metadata?.zapliga_plan_version !== '1') {
      return stripe.products.update(existing.id, { metadata });
    }
    return existing;
  }
  return stripe.products.create({ name, description, metadata: { zapliga_code: code, zapliga_catalog: '2026-09', zapliga_kind: code === 'sdr_seat' ? 'sdr_seat' : 'base_plan', zapliga_plan_version: '1' } });
}

async function findOrCreatePrice(productId: string, lookupKey: string, amount: number, interval: 'month' | 'year', metadata: Record<string, string> = {}) {
  const prices = await stripe.prices.list({ limit: 10, lookup_keys: [lookupKey], type: 'recurring' });
  const existing = prices.data[0];
  const canonicalMetadata = { ...existing?.metadata, ...metadata, zapliga_catalog: '2026-09', zapliga_plan_version: '1' };
  if (existing) {
    const existingInterval = existing.recurring?.interval;
    if (!existing.active || String(existing.product) !== productId || existing.currency !== 'brl' || Number(existing.unit_amount) !== amount || existingInterval !== interval) {
      throw new Error(`Stripe Price ${lookupKey} already exists with incompatible immutable attributes`);
    }
    const metadataNeedsUpdate = Object.entries(metadata).some(([key, value]) => existing.metadata?.[key] !== value)
      || existing.metadata?.zapliga_catalog !== '2026-09'
      || existing.metadata?.zapliga_plan_version !== '1';
    return metadataNeedsUpdate ? stripe.prices.update(existing.id, { metadata: canonicalMetadata }) : existing;
  }
  return stripe.prices.create({ product: productId, currency: 'brl', unit_amount: amount, recurring: { interval }, lookup_key: lookupKey, metadata: { ...metadata, zapliga_catalog: '2026-09', zapliga_plan_version: '1' } });
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const plan of catalogPlans) {
      const versionId = `plan_${plan.code}_v1`;
      const product = await findOrCreateProduct(plan.code, plan.productName, plan.description);
      const priceMetadata = { zapliga_plan_code: plan.code, zapliga_kind: 'base_plan' };
      const month = await findOrCreatePrice(product.id, `zapliga_${plan.code}_month_v1`, plan.monthly, 'month', priceMetadata);
      const year = await findOrCreatePrice(product.id, `zapliga_${plan.code}_year_v1`, plan.yearly, 'year', priceMetadata);
      await client.query(`UPDATE billing_plan_versions SET status = 'active', display_name = $2, description = $3, sort_order = $4, max_sdrs = $5, included_sdrs = $6, feature_entitlements = $7::jsonb, limit_entitlements = $8::jsonb, effective_from = COALESCE(effective_from, now()), updated_at = now() WHERE id = $1`, [versionId, plan.productName.replace('ZapLiga ', ''), plan.description, plan.sortOrder, plan.maxSdrs, plan.includedSdrs, JSON.stringify(plan.features), JSON.stringify(plan.limits)]);
      for (const [price, interval] of [[month, 'month'], [year, 'year']] as const) await client.query(`INSERT INTO billing_plan_prices (id, plan_version_id, stripe_price_id, livemode, currency, unit_amount, billing_interval, interval_count, active) VALUES ($1, $2, $3, $4, 'brl', $5, $6, 1, true) ON CONFLICT (stripe_price_id, livemode) DO UPDATE SET active = true, unit_amount = EXCLUDED.unit_amount, updated_at = now()`, [`price_${plan.code}_${interval}_v1_${livemode ? 'live' : 'test'}`, versionId, price.id, livemode, Number(price.unit_amount), interval]);
      console.log(`${plan.code}: ${month.id} / ${year.id}`);
    }
    const addonProduct = await findOrCreateProduct('sdr_seat', 'ZapLiga SDR adicional', 'SDR adicional contratado por quantidade');
    const addonMonth = await findOrCreatePrice(addonProduct.id, 'zapliga_sdr_seat_month_v1', 1990, 'month', { zapliga_kind: 'sdr_seat', zapliga_addon_code: 'sdr_seat' });
    const addonYear = await findOrCreatePrice(addonProduct.id, 'zapliga_sdr_seat_year_v1', 19900, 'year', { zapliga_kind: 'sdr_seat', zapliga_addon_code: 'sdr_seat' });
    for (const [price, interval, amount] of [[addonMonth, 'month', 1990], [addonYear, 'year', 19900]] as const) await client.query(`INSERT INTO billing_addon_prices (id, addon_code, version, display_name, description, stripe_product_id, stripe_price_id, livemode, currency, unit_amount, billing_interval, interval_count, active, effective_from) VALUES ($1, 'sdr_seat', 1, 'SDR adicional', 'Seat de SDR adicional', $2, $3, $4, 'brl', $5, $6, 1, true, now()) ON CONFLICT (stripe_price_id, livemode) DO UPDATE SET active = true, unit_amount = EXCLUDED.unit_amount, updated_at = now()`, [`addon_sdr_seat_${interval}_v1_${livemode ? 'live' : 'test'}`, addonProduct.id, price.id, livemode, amount, interval]);
    console.log(`sdr_seat: ${addonMonth.id} / ${addonYear.id}`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); await pool.end(); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
