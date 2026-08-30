import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './app/App';
import { AuthProvider } from './features/auth/AuthProvider';
import './styles/global.css';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) Sentry.init({ dsn: sentryDsn, environment: import.meta.env.MODE });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<div className="error-boundary-fallback"><p>Algo deu errado. Recarregue a página.</p></div>}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
