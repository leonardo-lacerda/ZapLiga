import { StripeClientService } from './stripe.client';

describe('StripeClientService production configuration', () => {
  const names = [
    'NODE_ENV',
    'BILLING_ENFORCEMENT_MODE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PORTAL_CONFIGURATION_ID',
    'STRIPE_LIVEMODE',
  ] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const setProduction = () => {
    process.env.NODE_ENV = 'production';
    process.env.BILLING_ENFORCEMENT_MODE = 'enforce';
    process.env.STRIPE_SECRET_KEY = 'sk_live_zapliga_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_zapliga_test';
    process.env.STRIPE_LIVEMODE = 'true';
  };

  it('fails closed when the live portal configuration is missing', () => {
    setProduction();
    delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    expect(() => new StripeClientService()).toThrow(/portal configuration/i);
  });

  it('fails closed when production billing is pointed at test mode', () => {
    setProduction();
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_test';
    process.env.STRIPE_LIVEMODE = 'false';
    expect(() => new StripeClientService()).toThrow(/STRIPE_LIVEMODE=true/i);
  });

  it('fails closed when the live flag is paired with a test secret key', () => {
    setProduction();
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_live';
    process.env.STRIPE_SECRET_KEY = 'sk_test_zapliga_test';
    expect(() => new StripeClientService()).toThrow(/does not match/i);
  });

  it('accepts a complete live configuration', () => {
    setProduction();
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_live';
    const client = new StripeClientService();
    expect(client.configured).toBe(true);
    expect(client.livemode).toBe(true);
  });
});
