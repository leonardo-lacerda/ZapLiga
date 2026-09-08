import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { checkMetricsExportStatus, downloadCompletedMetricsExport, downloadMetricsCsv, MetricsQueryParams } from './metrics.api';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutos

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Operação cancelada', 'AbortError')); return; }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { window.clearTimeout(timer); reject(new DOMException('Operação cancelada', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

async function waitAndDownload(exportId: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await wait(POLL_INTERVAL_MS, signal);
    const job = await checkMetricsExportStatus(exportId, signal);
    if (job.status === 'completed') { await downloadCompletedMetricsExport(exportId, signal); return; }
    if (job.status === 'failed') throw new Error(job.errorMessage ?? 'A exportação falhou');
  }
  throw new Error('A exportação está demorando mais que o esperado — tente novamente em instantes.');
}

export function ExportCsvButton({ dataset, params, label = 'Exportar CSV' }: { dataset: string; params: MetricsQueryParams; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeExport = useRef<AbortController | null>(null);
  useEffect(() => () => { activeExport.current?.abort(); }, []);

  const run = async () => {
    const controller = new AbortController();
    activeExport.current?.abort();
    activeExport.current = controller;
    setBusy(true); setError('');
    try {
      const result = await downloadMetricsCsv(dataset, params, controller.signal);
      if (result.async) await waitAndDownload(result.exportId, controller.signal);
    } catch (reason) {
      if (!(reason instanceof Error && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (activeExport.current === controller) { activeExport.current = null; setBusy(false); }
    }
  };

  return <span className="metrics-export-inline">
    <Button variant="ghost" onClick={() => void run()} disabled={busy}>{busy ? 'Exportando…' : label}</Button>
    {error && <small className="metrics-export-error" role="alert">{error}</small>}
  </span>;
}
