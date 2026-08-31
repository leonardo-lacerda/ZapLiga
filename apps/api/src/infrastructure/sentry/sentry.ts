import * as Sentry from '@sentry/node';

const redact = (value: string) => value
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
  .replace(/\b\d{10,15}\b/g, '[phone]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
  .replace(/([?&](?:token|ticket)=)[^&\s]+/gi, '$1[redacted]');

const sanitizeEvent = (event: any) => {
  if (event.request) {
    delete event.request.data; delete event.request.cookies; delete event.request.query_string;
    if (event.request.headers) for (const key of Object.keys(event.request.headers)) if (/authorization|cookie|token/i.test(key)) delete event.request.headers[key];
  }
  if (event.user) { delete event.user.email; delete event.user.ip_address; }
  if (event.message) event.message = redact(event.message);
  for (const value of event.exception?.values ?? []) if (value.value) value.value = redact(value.value);
  for (const breadcrumb of event.breadcrumbs ?? []) { if (breadcrumb.message) breadcrumb.message = redact(breadcrumb.message); delete breadcrumb.data; }
  return event;
};

// No-op unless SENTRY_DSN is set, same "optional service" pattern used
// elsewhere in this app (e.g. the Resend/Waxum clients).
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({ dsn, environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development', sendDefaultPii: false, beforeSend: sanitizeEvent });
}

export { Sentry };
