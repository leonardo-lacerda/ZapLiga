import { canUseProvisioning, errorExplanation, formatPhone, normalizeSmsCode, validatePhoneNumber } from './provisioning.labels';

describe('provisioning helpers', () => {
  it('só libera o recurso com a flag ligada para líder ou super_admin', () => {
    expect(canUseProvisioning({ flags: { whatsapp_provisioning: true }, role: 'leader' })).toBe(true);
    expect(canUseProvisioning({ flags: { whatsapp_provisioning: true }, role: 'sdr', isSuperAdmin: true })).toBe(true);
    expect(canUseProvisioning({ flags: { whatsapp_provisioning: true }, role: 'sdr' })).toBe(false);
    expect(canUseProvisioning({ flags: { whatsapp_provisioning: false }, role: 'leader', isSuperAdmin: true })).toBe(false);
    expect(canUseProvisioning({ flags: null, role: 'leader' })).toBe(false);
  });

  it('aceita o código SMS com ou sem traço/espaço', () => {
    expect(normalizeSmsCode('123-456')).toBe('123456');
    expect(normalizeSmsCode(' 123 456 ')).toBe('123456');
    expect(normalizeSmsCode('1234567')).toBe('123456');
  });

  it('valida o número brasileiro e formata para exibição', () => {
    expect(validatePhoneNumber('55', '(11) 98765-4321')).toBeNull();
    expect(validatePhoneNumber('55', '1133334444')).toBeNull();
    expect(validatePhoneNumber('55', '5511987654321')).toMatch(/sem o código do país/);
    expect(validatePhoneNumber('55', '98765')).toMatch(/DDD/);
    expect(validatePhoneNumber('', '11987654321')).toMatch(/código do país/);
    expect(formatPhone('5511987654321')).toBe('+55 11 98765-4321');
    expect(formatPhone('14155550100')).toBe('+14155550100');
  });

  it('tem explicação em português para todo errorCode do contrato', () => {
    for (const code of ['egress_offline', 'egress_mismatch', 'no_internet', 'phone_start_failed', 'adb_failed', 'install_failed', 'unknown_screen', 'number_banned', 'sms_rejected', 'timeout', 'pair_failed', 'link_timeout', 'worker_lost', 'cancelled', 'internal']) {
      expect(errorExplanation(code).title).not.toBe('O cadastro não foi concluído');
    }
    expect(errorExplanation('algo_novo').title).toBe('O cadastro não foi concluído');
  });
});
