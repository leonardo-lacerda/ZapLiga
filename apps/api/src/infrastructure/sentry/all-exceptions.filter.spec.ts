import { BadRequestException, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function host() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const http = { getResponse: () => ({ status }), getRequest: () => ({ method: 'GET', url: '/api/tenants/t1/numbers/n1/qr?x=1' }) };
  return { host: { switchToHttp: () => http } as any, status, json };
}

describe('AllExceptionsFilter', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('keeps a deliberate HttpException as it is', () => {
    const { host: h, status, json } = host();
    new AllExceptionsFilter().catch(new BadRequestException('label é obrigatório'), h);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: 'label é obrigatório' }));
  });

  it('answers a failed Waxum request with what Waxum said', () => {
    const { host: h, status, json } = host();
    const error = Object.assign(new Error('Waxum 500: {"success":false,"error":{"message":"session store locked"}}'), { statusCode: 500 });
    new AllExceptionsFilter().catch(error, h);
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ statusCode: 502, message: 'O Waxum recusou o pedido (500): {"success":false,"error":{"message":"session store locked"}}' });
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('GET /api/tenants/t1/numbers/n1/qr: Waxum 500'), expect.any(String));
  });

  it('logs any other failure and keeps the generic answer', () => {
    const { host: h, status, json } = host();
    new AllExceptionsFilter().catch(new TypeError('boom'), h);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('boom'), expect.any(String));
  });
});
