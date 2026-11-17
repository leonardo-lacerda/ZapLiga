import { formatTime, stepLabel } from './provisioning.labels';
import type { Job } from './provisioning.types';

/** Linha do tempo do job: cada `history` com o rótulo em português do `step`. */
export function JobTimeline({ job }: { job: Job }) {
  const history = job.history ?? [];
  const finished = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
  return <ol className="provisioning-timeline" aria-label="Linha do tempo do cadastro">
    {history.map((entry, index) => {
      const isLast = index === history.length - 1;
      const state = isLast && !finished ? 'is-current' : job.status === 'failed' && isLast ? 'is-failed' : 'is-done';
      return <li key={`${entry.step}-${entry.at}-${index}`} className={state} aria-current={isLast && !finished ? 'step' : undefined}>
        <span className="provisioning-timeline-dot" />
        <div>
          <strong>{stepLabel(entry.step)}</strong>
          {entry.message && <small>{entry.message}</small>}
        </div>
        <time dateTime={entry.at}>{formatTime(entry.at)}</time>
      </li>;
    })}
    {!history.length && <li className="is-current"><span className="provisioning-timeline-dot" /><div><strong>{stepLabel(job.step)}</strong></div><time /></li>}
  </ol>;
}
