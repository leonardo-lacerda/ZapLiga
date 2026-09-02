import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import express from 'express';
import { AppModule } from './app.module';
import { SdrGateway } from './modules/sdrs/sdr.gateway';
import { initSentry, Sentry } from './infrastructure/sentry/sentry';
import { AllExceptionsFilter } from './infrastructure/sentry/all-exceptions.filter';

initSentry();
// The dialer's timers/WebSocket callbacks run outside any Nest request
// cycle, so an exception there only ever surfaces here, not in the
// exception filter below. Report then crash — same as Node's default
// behavior with no handler at all, just with visibility first.
process.on('uncaughtException', (error) => {
  Sentry.captureException(error);
  console.error('Uncaught exception; detalhes enviados ao monitoramento sanitizado.');
  void Sentry.close(2000).finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
  console.error('Unhandled rejection; detalhes enviados ao monitoramento sanitizado.');
  void Sentry.close(2000).finally(() => process.exit(1));
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(express.json({
    limit: '5mb',
    verify: (request: any, _response, buffer) => { request.rawBody = Buffer.from(buffer); },
  }));
  app.useGlobalFilters(new AllExceptionsFilter());
  // Let Nest run OnModuleDestroy hooks on deploys/restarts so the dialer can
  // close media sockets and persist a clean terminal state for active calls.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  // The API is a pure JSON backend (no server-rendered HTML), so CSP/COEP add
  // no protection here and only risk breaking the health check or fetch()
  // clients; keep the headers that matter for an API (nosniff, no-referrer,
  // frameguard) and skip the browser-page-oriented ones.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginOpenerPolicy: false, crossOriginResourcePolicy: false }));
  const configuredOrigins = process.env.WEB_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
  const isHttpsOrigin = (value: string) => {
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
  };
  const publicApiOrigin = process.env.PUBLIC_API_ORIGIN?.trim() ?? '';
  // Fail-safe by default: validate real deployments unless the environment
  // explicitly declares itself dev/test, instead of only when it explicitly
  // declares itself production. An incomplete production .env that never
  // sets NODE_ENV must still be rejected, not silently boot with defaults.
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    const unsafeDefaults = new Set(['dev-only-change-this-secret', 'change-this-access-secret', 'zapcall-local-access-secret-change-me', 'zapcall-local-waxum-token', 'change-this-local-secret', 'change-this-data-protection-secret', 'change-this-metrics-token', 'zapcall-local-jwt-secret-change-me']);
    if (process.env.E2E_TEST_MODE === 'true') throw new Error('E2E_TEST_MODE nunca pode ser habilitado em producao');
    if (!process.env.JWT_ACCESS_SECRET || !process.env.WAXUM_API_KEY || !process.env.WAXUM_JWT_SECRET || !process.env.WEB_ORIGIN || !configuredOrigins.every(isHttpsOrigin) || !publicApiOrigin || !isHttpsOrigin(publicApiOrigin) || !process.env.DATA_PROTECTION_SECRET || !process.env.METRICS_TOKEN || process.env.AUTH_COOKIE_SECURE !== 'true' || unsafeDefaults.has(process.env.JWT_ACCESS_SECRET) || unsafeDefaults.has(process.env.WAXUM_API_KEY) || unsafeDefaults.has(process.env.WAXUM_JWT_SECRET) || unsafeDefaults.has(process.env.DATA_PROTECTION_SECRET) || unsafeDefaults.has(process.env.METRICS_TOKEN)) throw new Error('Defina segredos reais, WEB_ORIGIN/PUBLIC_API_ORIGIN HTTPS, METRICS_TOKEN e AUTH_COOKIE_SECURE=true em producao');
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    app.use((request: any, response: any, next: () => void) => {
      if (request.path === '/health' || request.secure || request.headers['x-forwarded-proto'] === 'https') return next();
      response.status(426).json({ message: 'HTTPS obrigatório' });
    });
  }
  app.enableCors({ origin: configuredOrigins?.length ? configuredOrigins : true, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  app.get(SdrGateway).attach(app.getHttpServer());
  console.log(`ZapLiga API listening on http://localhost:${port}`);
}
void bootstrap().catch((error) => {
  Sentry.captureException(error);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Bootstrap failed: ${message.slice(0, 300)}`);
  process.exitCode = 1;
});
