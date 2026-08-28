import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { SdrGateway } from './modules/sdrs/sdr.gateway';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  if (process.env.NODE_ENV === 'production') {
    const unsafeDefaults = new Set(['dev-only-change-this-secret', 'change-this-access-secret', 'zapcall-local-waxum-token', 'zapcall-local-jwt-secret-change-me']);
    if (!process.env.JWT_ACCESS_SECRET || !process.env.WAXUM_API_KEY || !process.env.WAXUM_JWT_SECRET || !process.env.WEB_ORIGIN || unsafeDefaults.has(process.env.JWT_ACCESS_SECRET) || unsafeDefaults.has(process.env.WAXUM_API_KEY) || unsafeDefaults.has(process.env.WAXUM_JWT_SECRET)) throw new Error('Defina segredos reais e WEB_ORIGIN em produção');
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    app.use((request: any, response: any, next: () => void) => {
      if (request.path === '/health' || request.secure || request.headers['x-forwarded-proto'] === 'https') return next();
      response.status(426).json({ message: 'HTTPS obrigatório' });
    });
  }
  const configuredOrigins = process.env.WEB_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean);
  app.enableCors({ origin: configuredOrigins?.length ? configuredOrigins : true, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  app.get(SdrGateway).attach(app.getHttpServer());
  console.log(`ZapCall API listening on http://localhost:${port}`);
}
void bootstrap();
