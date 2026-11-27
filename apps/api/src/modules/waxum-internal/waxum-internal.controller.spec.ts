import { UnauthorizedException } from '@nestjs/common';
import { WaxumInternalController } from './waxum-internal.controller';

const build = (line: unknown, profile: unknown) => {
  const db = { query: jest.fn(async () => ({ rows: line ? [line] : [] })) };
  const numbers = { deviceProfile: jest.fn(async () => profile) };
  const controller = new WaxumInternalController(db as any, numbers as any);
  return { controller, db, numbers };
};

describe('WaxumInternalController', () => {
  const key = process.env.WAXUM_API_KEY;

  beforeAll(() => { process.env.WAXUM_API_KEY = 'test-key'; });
  afterAll(() => { process.env.WAXUM_API_KEY = key; });

  it('rejects a caller without the shared key', async () => {
    const { controller } = build(null, null);
    await expect(controller.deviceProfile('s1')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.deviceProfile('s1', 'Bearer wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers null for a session no line owns', async () => {
    const { controller } = build(null, null);
    await expect(controller.deviceProfile('s1', 'Bearer test-key')).resolves.toEqual({ profile: null });
  });

  it('answers null when the line has no frozen profile', async () => {
    const { controller } = build({ id: 'n1', tenant_id: 't1' }, null);
    await expect(controller.deviceProfile('s1', 'Bearer test-key')).resolves.toEqual({ profile: null });
  });

  it('answers the frozen profile of the line that owns the session', async () => {
    const profile = { version: 1, surface: 'ANDROID_PHONE' };
    const { controller, numbers } = build({ id: 'n1', tenant_id: 't1' }, profile);
    await expect(controller.deviceProfile('s1', 'Bearer test-key')).resolves.toEqual({ profile });
    expect(numbers.deviceProfile).toHaveBeenCalledWith('t1', 'n1');
  });
});
