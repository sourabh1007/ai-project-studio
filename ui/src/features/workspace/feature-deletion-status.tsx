import { useId, useState, useSyncExternalStore } from 'react';
import { featureDeletionStore, type FeatureDeletionStore } from '../../lib/feature-deletion-store.js';
import { CheckIcon, CloseIcon, TrashIcon, WarningIcon } from '../../components/icons.js';
import { Spinner } from '../../components/loading.js';
import './pr-import-status.css';

export function FeatureDeletionStatus({ store = featureDeletionStore }: { store?: FeatureDeletionStore }) {
  const jobs = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (jobs.length === 0) return null;
  const running = jobs.filter((job) => job.status === 'running').length;
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const succeeded = jobs.filter((job) => job.status === 'succeeded');
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const working = running + queued > 0;
  const summary = [
    running > 0 && `${running} deleting`,
    queued > 0 && `${queued} queued`,
    succeeded.length > 0 && `${succeeded.length} deleted`,
    failed > 0 && `Attention needed: ${failed}`,
  ].filter(Boolean).join(' / ');
  return (
    <section className="pr-import-status feature-deletion-status" aria-label="Feature deletions"
      data-state={working ? 'running' : failed > 0 ? 'failed' : 'succeeded'}
      data-active={working}>
      <div className="pr-import-head"><TrashIcon size={16} /><strong>Feature deletions</strong>
        <span className="pr-import-summary" role="status">{summary}</span>
        <div className="feature-deletion-actions">
          <button type="button" className="pr-import-action" aria-expanded={expanded} aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide details' : 'Show details'}</button>
          {succeeded.length > 0 && <button type="button" className="pr-import-action"
            onClick={() => succeeded.forEach((job) => store.dismiss(job.id))}>Clear completed</button>}
        </div>
      </div>
      {working && <div className="pr-import-bar" role="progressbar" aria-label="Deleting features">
        <span className="pr-import-bar-activity" style={{ width: '100%' }} />
      </div>}
      <ul className="feature-deletion-jobs" id={detailsId} hidden={!expanded}>
        {jobs.map((job) => {
          const pending = job.status === 'queued' || job.status === 'running';
          return <li key={job.id} data-state={job.status}>
            <span className="feature-deletion-icon">
              {pending ? <Spinner size={14} label={job.status === 'queued' ? 'Deletion queued' : 'Deleting feature'} showLabel={false} />
                : job.status === 'failed' ? <WarningIcon size={14} /> : <CheckIcon size={14} />}
            </span>
            <span className="feature-deletion-text"><strong title={job.name}>{job.name}</strong>
              <span role={job.status === 'failed' ? 'alert' : 'status'}>{job.message}</span></span>
            {!pending && <button type="button" className="tree-action" aria-label={`Dismiss deletion of ${job.name}`}
              onClick={() => store.dismiss(job.id)}><CloseIcon size={12} /></button>}
          </li>;
        })}
      </ul>
    </section>
  );
}
