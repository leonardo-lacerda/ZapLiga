import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './app/App';
import { AuthProvider } from './features/auth/AuthProvider';
import './styles/global.css';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
const redact = (value: string) => value
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
  .replace(/\b\d{10,15}\b/g, '[phone]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
  .replace(/([?&](?:token|ticket)=)[^&\s]+/gi, '$1[redacted]');
if (sentryDsn) Sentry.init({
  dsn: sentryDsn,
  environment: import.meta.env.MODE,
  sendDefaultPii: false,
  beforeSend(event) {
    if (event.request) { delete event.request.data; delete event.request.cookies; delete event.request.query_string; delete event.request.headers; }
    if (event.user) { delete event.user.email; delete event.user.ip_address; }
    if (event.message) event.message = redact(event.message);
    for (const value of event.exception?.values ?? []) if (value.value) value.value = redact(value.value);
    event.breadcrumbs = event.breadcrumbs?.map((breadcrumb) => ({ ...breadcrumb, message: breadcrumb.message ? redact(breadcrumb.message) : breadcrumb.message, data: undefined }));
    return event;
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<div className="error-boundary-fallback"><p>Algo deu errado. Recarregue a página.</p></div>}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
