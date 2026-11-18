import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { fetchRecentJobs } from './provisioning.api';
import { appLabels, formatDateTime, isJobActive, jobTitle, statusLabels, statusTone, stepLabel } from './provisioning.labels';
import type { Job } from './provisioning.types';

/** Últimos cadastros da empresa, para reabrir um que está em andamento depois de recarregar a página. */
export function RecentJobs({ tenantId, onOpen }: { tenantId: string; onOpen: (jobId: string) => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setJobs(await fetchRecentJobs(tenantId, 10)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  return <Panel className="provisioning-recent">
    <SectionHeader title="Cadastros recentes" description="Abra um cadastro para acompanhar ou responder ao robô." action={<Button variant="ghost" icon="refresh" onClick={() => void load()}>Atualizar</Button>} />
    {error && <p className="provisioning-field-error">{error}</p>}
    {jobs === null && !error && <p className="subtle">Carregando…</p>}
    {jobs && !jobs.length && <p className="subtle">Nenhum cadastro feito ainda.</p>}
    {jobs && jobs.length > 0 && <ul className="provisioning-recent-list">
      {jobs.map((job) => <li key={job.id}>
        <div>
          <strong>{jobTitle(job)}</strong>
          <small>{job.phoneName ?? job.geelarkPhoneId}{job.app ? ` · ${appLabels[job.app] ?? job.app}` : ''} · {formatDateTime(job.createdAt)}</small>
          <small>{stepLabel(job.step)}</small>
        </div>
        <Badge tone={statusTone[job.status] ?? 'neutral'}>{statusLabels[job.status] ?? job.status}</Badge>
        <Button variant={isJobActive(job) ? 'secondary' : 'ghost'} onClick={() => onOpen(job.id)} aria-label={`${isJobActive(job) ? 'Acompanhar' : 'Abrir'} ${job.mode === 'network_check' ? `teste de internet de ${job.phoneName ?? job.geelarkPhoneId}` : job.mode === 'control' ? `sessão de ${job.phoneName ?? job.geelarkPhoneId}` : `cadastro de ${jobTitle(job)}`}`}>{isJobActive(job) ? 'Acompanhar' : 'Abrir'}</Button>
      </li>)}
    </ul>}
  </Panel>;
}
