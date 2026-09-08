import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportCsvButton } from './ExportCsvButton';
import { checkMetricsExportStatus, downloadMetricsCsv } from './metrics.api';

vi.mock('./metrics.api', () => ({
  downloadMetricsCsv: vi.fn(async () => ({ async: true, exportId: 'export-1' })),
  checkMetricsExportStatus: vi.fn(async () => ({ status: 'pending' })),
  downloadCompletedMetricsExport: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ExportCsvButton', () => {
  it('interrompe o polling quando a tela desmonta', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<ExportCsvButton dataset="calls" params={{ from: '2026-09-01', to: '2026-09-08' }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
      await Promise.resolve();
    });
    expect(downloadMetricsCsv).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(checkMetricsExportStatus).not.toHaveBeenCalled();
  });
});
