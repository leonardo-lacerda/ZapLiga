import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Sentry } from './sentry';

// How much of Waxum's own answer reaches the screen.
const WAXUM_DETAIL_MAX = 300;

// Mirrors Nest's default exception formatting, but also reports anything
// that isn't a deliberate 4xx HttpException (validation errors, guards,
// etc. stay out of Sentry — only genuinely unexpected failures go there).
// A failed Waxum request (WaxumClient: `Waxum <status>: <body>` with `statusCode`)
// answers 502 with what Waxum said, instead of a bare "Internal server error"
// that tells the operator nothing; every unexpected failure is also logged.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) Sentry.captureException(exception);
      const body = exception.getResponse();
      response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }
    Sentry.captureException(exception);
    const request = host.switchToHttp().getRequest();
    const error = exception as Error & { statusCode?: number };
    this.logger.error(`${request?.method} ${String(request?.url ?? '').split('?')[0]}: ${String(error?.message ?? exception).slice(0, 1000)}`, error?.stack);
    if (typeof error?.statusCode === 'number' && /^Waxum \d+:/.test(String(error.message))) {
      const detail = String(error.message).replace(/^Waxum \d+:\s*/, '').slice(0, WAXUM_DETAIL_MAX);
      response.status(HttpStatus.BAD_GATEWAY).json({ statusCode: HttpStatus.BAD_GATEWAY, message: `O Waxum recusou o pedido (${error.statusCode}): ${detail}` });
      return;
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
  }
}
