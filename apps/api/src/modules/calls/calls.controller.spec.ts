import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CallsController } from './calls.controller';
import { ManualCallDto } from './dto/manual-call.dto';

describe('CallsController manual call line choice', () => {
  const make = () => {
    const dialer = { connectedStationFor: jest.fn().mockResolvedValue(true), manualCallWithInput: jest.fn().mockResolvedValue({ callId: 'call-1', status: 'reserved', leadId: 'lead-1' }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new CallsController({} as any, dialer as any, audit as any, {} as any);
    return { controller, dialer };
  };
  const leader = { id: 'user-1', platformRole: null, tenantMembership: { role: 'leader', tenantId: 'tenant-1' } };

  it('dials from the line the operator picked', async () => {
    const { controller, dialer } = make();
    await controller.manual({ phone: '5511988887777', numberId: ' num-2 ' } as ManualCallDto, 'tenant-1', leader);
    expect(dialer.manualCallWithInput).toHaveBeenCalledWith(expect.objectContaining({ phone: '5511988887777', numberId: 'num-2' }), 'tenant-1', 'user-1');
  });

  it('keeps the automatic line choice when none is picked', async () => {
    const { controller, dialer } = make();
    await controller.manual({ phone: '5511988887777' } as ManualCallDto, 'tenant-1', leader);
    expect(dialer.manualCallWithInput.mock.calls[0][0].numberId).toBeUndefined();
  });

  it('accepts numberId in the request body', async () => {
    const dto = plainToInstance(ManualCallDto, { phone: '5511988887777', numberId: 'num-2' });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });
});
