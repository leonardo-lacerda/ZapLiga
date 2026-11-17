import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../services/api';
import { fetchJob } from './provisioning.api';
import { isJobFinished } from './provisioning.labels';
import type { Job } from './provisioning.types';

export const JOB_POLL_INTERVAL_MS = 2000;

const isOlder = (next: Job, current: Job | null) => {
  if (!current) return false;
  const a = Date.parse(next.updatedAt);
  const b = Date.parse(current.updatedAt);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
};

/**
 * Acompanha um job consultando `GET jobs/{id}` a cada `intervalMs` (padrão 2 s).
 * Para quando o job termina (done/failed/cancelled), quando o job some (404) ou ao desmontar.
 * `applyJob` permite aplicar na hora o Job devolvido por uma ação (SMS, perfil, cancelar...).
 */
export function useProvisioningJob(tenantId: string, jobId: string, intervalMs = JOB_POLL_INTERVAL_MS) {
  const [job, setJob] = useState<Job | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const jobRef = useRef<Job | null>(null);

  const applyJob = useCallback((next: Job) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    jobRef.current = null;
    setJob(null); setLoadError(''); setNotFound(false);

    const tick = async () => {
      try {
        const next = await fetchJob(tenantId, jobId);
        if (stopped) return;
        // Uma consulta que saiu antes de uma ação (ex.: enviar o SMS) não pode desfazer o estado novo.
        if (!isOlder(next, jobRef.current)) { jobRef.current = next; setJob(next); }
        setLoadError('');
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 404) { setNotFound(true); return; }
        setLoadError(error instanceof TypeError ? 'Sem resposta do servidor. Tentando de novo…' : error instanceof Error ? error.message : String(error));
      }
      if (stopped || isJobFinished(jobRef.current)) return;
      timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();

    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [tenantId, jobId, intervalMs]);

  return { job, applyJob, loadError, notFound };
}
