import { useSyncExternalStore } from 'react';
import { featureDeletionStore, type FeatureDeletionStore } from '../../lib/feature-deletion-store.js';
import { CheckIcon, CloseIcon, TrashIcon, WarningIcon } from '../../components/icons.js';
import { Spinner } from '../../components/loading.js';
import './pr-import-status.css';

export function FeatureDeletionStatus({ store = featureDeletionStore }: { store?: FeatureDeletionStore }) {
  const jobs = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (jobs.length === 0) return null;
  const working = jobs.some((job) => job.status === 'running' || job.status === 'queued');
  return (
    <section className="pr-import-status feature-deletion-status" aria-label="Feature deletions"
      data-state={jobs.some((job) => job.status === 'failed') ? 'failed' : working ? 'running' : 'succeeded'}
      data-active={working}>
      <div className="pr-import-head"><TrashIcon size={16} /><strong>Feature deletions</strong>
        <span className="pr-import-summary" role="status">{working ? 'Working in background' : 'Finished'}</span>
      </div>
      {working && <div className="pr-import-bar" role="progressbar" aria-label="Deleting features">
        <span className="pr-import-bar-activity" style={{ width: '100%' }} />
      </div>}
      <ul className="feature-deletion-jobs">
        {jobs.map((job) => {
          const pending = job.status === 'queued' || job.status === 'running';
          return <li key={job.id}>
            {pending ? <Spinner size={14} label="Deletion pending" showLabel={false} />
              : job.status === 'failed' ? <WarningIcon size={14} /> : <CheckIcon size={14} />}
            <span><strong>{job.name}</strong><span role={job.status === 'failed' ? 'alert' : 'status'}>{job.message}</span></span>
            {!pending && <button type="button" className="tree-action" aria-label={`Dismiss deletion of ${job.name}`}
              onClick={() => store.dismiss(job.id)}><CloseIcon size={12} /></button>}
          </li>;
        })}
      </ul>
    </section>
  );
}
