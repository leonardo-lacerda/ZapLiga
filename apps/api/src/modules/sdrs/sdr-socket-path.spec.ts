import { parseSdrSocketPath } from './sdr-socket-path';

describe('parseSdrSocketPath', () => {
  it('routes the legacy unscoped control path', () => {
    expect(parseSdrSocketPath('/ws/sdr')).toEqual({ kind: 'control', tenantId: undefined });
  });

  it('routes a tenant-scoped control path', () => {
    expect(parseSdrSocketPath('/ws/tenants/tenant-1/sdr')).toEqual({ kind: 'control', tenantId: 'tenant-1' });
  });

  it('routes a tenant-scoped media path', () => {
    expect(parseSdrSocketPath('/ws/tenants/tenant-1/sdr/sdr-1/call/call-1')).toEqual({ kind: 'media', tenantId: 'tenant-1', sdrId: 'sdr-1', callId: 'call-1' });
  });

  it('routes the legacy unscoped media path', () => {
    expect(parseSdrSocketPath('/ws/sdr/sdr-1/call/call-1')).toEqual({ kind: 'media', tenantId: undefined, sdrId: 'sdr-1', callId: 'call-1' });
  });

  it('rejects anything else', () => {
    expect(parseSdrSocketPath('/ws/unknown')).toEqual({ kind: 'none' });
    expect(parseSdrSocketPath('/')).toEqual({ kind: 'none' });
  });
});
