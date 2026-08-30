import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Sentry } from './sentry';

// Mirrors Nest's default exception formatting, but also reports anything
// that isn't a deliberate 4xx HttpException (validation errors, guards,
// etc. stay out of Sentry — only genuinely unexpected failures go there).
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (!(exception instanceof HttpException) || status >= 500) Sentry.captureException(exception);
    const body = exception instanceof HttpException ? exception.getResponse() : { statusCode: status, message: 'Internal server error' };
    response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}
