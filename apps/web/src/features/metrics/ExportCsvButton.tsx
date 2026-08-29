import { useState } from 'react';
import { Button } from '../../components/ui';
import { checkMetricsExportStatus, downloadCompletedMetricsExport, downloadMetricsCsv, MetricsQueryParams } from './metrics.api';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutos

async function waitAndDownload(exportId: string) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const job = await checkMetricsExportStatus(exportId);
    if (job.status === 'completed') { await downloadCompletedMetricsExport(exportId); return; }
    if (job.status === 'failed') throw new Error(job.errorMessage ?? 'A exportação falhou');
  }
  throw new Error('A exportação está demorando mais que o esperado — tente novamente em instantes.');
}

export function ExportCsvButton({ dataset, params, label = 'Exportar CSV' }: { dataset: string; params: MetricsQueryParams; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError('');
    try {
      const result = await downloadMetricsCsv(dataset, params);
      if (result.async) await waitAndDownload(result.exportId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return <span className="metrics-export-inline">
    <Button variant="ghost" onClick={() => void run()} disabled={busy}>{busy ? 'Exportando…' : label}</Button>
    {error && <small className="metrics-export-error" role="alert">{error}</small>}
  </span>;
}
