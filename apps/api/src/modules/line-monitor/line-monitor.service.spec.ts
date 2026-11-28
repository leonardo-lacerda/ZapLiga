import { LineMonitorService } from './line-monitor.service';

describe('LineMonitorService', () => {
  const make = (rows: Record<string, any[]> = {}) => {
    const db = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        const match = Object.keys(rows).find((key) => sql.includes(key));
        if (match) return { rows: rows[match] };
        if (sql.includes('FROM tenants')) return { rows: [{ timezone: 'America/Sao_Paulo' }] };
        return { rows: [] };
      }),
    };
    const daily = { upsertDay: jest.fn(async () => undefined) };
    const service = new LineMonitorService(db as any, {} as any, daily as any, { alerts: jest.fn(async () => []) } as any);
    return { db, daily, service };
  };

  it('validates the period at the boundary', async () => {
    const { service } = make();
    await expect(service.period('t1', '27/11/2026')).rejects.toThrow('Datas inválidas');
    await expect(service.period('t1', '2026-11-28', '2026-11-27')).rejects.toThrow('data inicial vem depois');
    await expect(service.period('t1', '2025-01-01', '2026-11-27')).rejects.toThrow('período máximo');
    expect(await service.period('t1', '2026-11-27')).toEqual({ from: '2026-11-27', to: '2026-11-27', timezone: 'America/Sao_Paulo' });
  });

  it('adds up a period from the daily rows and refreshes today first', async () => {
    const lines = [
      { number_id: 'n1', label: 'Previtas 13', calls: 46, answered: 12, talk_seconds: 2592, short_answered: 2, closed_1005: 8, waxum_failures: 0, no_whatsapp: 1, lost: false },
      { number_id: 'n2', label: 'Previtas 14', calls: 29, answered: 8, talk_seconds: 1496, short_answered: 1, closed_1005: 9, waxum_failures: 1, no_whatsapp: 0, lost: true },
    ];
    const { daily, service } = make({ 'FROM line_daily_stats d': lines });
    const report = await service.periodReport('t1', { from: '2026-11-27', to: '2999-01-01', timezone: 'America/Sao_Paulo' });
    expect(daily.upsertDay).toHaveBeenCalledWith('t1', expect.any(String), 'America/Sao_Paulo');
    expect(report.totals).toMatchObject({ calls: 75, answered: 20, closed_1005: 17, active_lines: 2, lost_lines: 1 });
  });

  it('exports the losses with what the line looked like when it fell', async () => {
    const { service } = make({ 'FROM line_loss_events e': [{ occurred_at: new Date('2026-11-27T22:10:57Z'), label: 'Previtas 14', cause: 'device_removed', code: 'device_removed', context: { waxumNode: 'edge-4', callsSincePairing: 29 } }] });
    const { fileName, content } = await service.exportCsv('t1', 'losses', { from: '2026-11-27', to: '2026-11-27', timezone: 'America/Sao_Paulo' });
    expect(fileName).toBe('monitor-linhas-losses-2026-11-27_2026-11-27.csv');
    expect(content.startsWith('﻿')).toBe(true);
    expect(content).toContain('2026-11-27T22:10:57.000Z,Previtas 14,device_removed,device_removed,,,edge-4,,,29');
  });

  it('refuses an empty note and a note for another tenant\'s line', async () => {
    const { service } = make();
    await expect(service.addNote('t1', 'u1', { body: '   ' })).rejects.toThrow('A nota precisa');
    await expect(service.addNote('t1', 'u1', { body: 'Liguei o Business', numberId: 'other' })).rejects.toThrow('Número não encontrado');
  });
});
