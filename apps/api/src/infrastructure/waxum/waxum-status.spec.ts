import { normalizeWaxumStatus } from './waxum-status';

describe('Waxum status normalization', () => {
  it('treats logged_in as connected and keeps the session phone', () => {
    expect(normalizeWaxumStatus({
      status: 'logged_in',
      is_logged_in: true,
      phone_number: '+55 (27) 98127-1965',
    })).toEqual({ connected: true, phone: '5527981271965', status: 'connected' });
  });

  it('supports status responses wrapped in session', () => {
    expect(normalizeWaxumStatus({ session: { status: 'ready', phone_number: '5511999999999' } }))
      .toEqual({ connected: true, phone: '5511999999999', status: 'connected' });
  });

  it('preserves a disconnected state', () => {
    expect(normalizeWaxumStatus({ status: 'disconnected' }))
      .toEqual({ connected: false, phone: null, status: 'disconnected' });
  });
});

