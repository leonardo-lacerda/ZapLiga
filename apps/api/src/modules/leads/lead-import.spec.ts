import { parseLeadCsvRow } from './lead-import';

describe('lead CSV import', () => {
  it('imports the minimal name,phone format', () => {
    expect(parseLeadCsvRow({ name: 'Maria', phone: '+55 (11) 99999-9999' })).toEqual({
      name: 'Maria',
      phone: '5511999999999',
    });
  });

  it('imports a Kommo export using Nome completo and Telefone comercial', () => {
    expect(parseLeadCsvRow({
      'Lead título': 'MANOEL',
      'Nome completo': 'Manoel Vieira',
      'Telefone comercial': '5521969538478',
      Celular: '',
    })).toEqual({
      name: 'Manoel Vieira',
      phone: '5521969538478',
    });
  });

  it('uses Kommo fallback columns and ignores invalid rows', () => {
    expect(parseLeadCsvRow({ 'Lead título': 'Rafael', Celular: '55 55 83999-0359' })).toEqual({
      name: 'Rafael',
      phone: '5555839990359',
    });
    expect(parseLeadCsvRow({ 'Nome completo': 'Sem telefone' })).toBeNull();
  });
});
