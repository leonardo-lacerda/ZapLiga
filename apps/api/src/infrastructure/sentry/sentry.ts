import * as Sentry from '@sentry/node';

// No-op unless SENTRY_DSN is set, same "optional service" pattern used
// elsewhere in this app (e.g. the Resend/Waxum clients).
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({ dsn, environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development' });
}

export { Sentry };
