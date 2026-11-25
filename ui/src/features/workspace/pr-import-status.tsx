import { useEffect, useMemo, useState } from 'react';
import { usePrImports } from '../../hooks/use-pr-imports.js';
import {
  isFinishedImport,
  prImportStore,
  type PrImportBatch,
  type PrImportJob,
  type PrImportApi,
  type PrImportStore,
} from '../../lib/pr-import-store.js';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  PullRequestIcon,
  RefreshIcon,
  WarningIcon,
} from '../../components/icons.js';
import { Spinner } from '../../components/loading.js';
import './pr-import-status.css';

/** A running import that has reported nothing for this long gets a hint. */
export const PR_IMPORT_STALL_MS = 60_000;

/** `{ running, queued, ... }` counts used by the header and its live region. */
export function summarizeImports(jobs: readonly PrImportJob[]) {
  const count = (status: PrImportJob['status']) =>
    jobs.filter((job) => job.status === status).length;
  const summary = {
    running: count('running'),
    queued: count('queued'),
    succeeded: count('succeeded'),
    failed: count('failed'),
    unknown: count('unknown'),
    cancelled: count('cancelled'),
  };
  const parts = [
    summary.running > 0 && `${summary.running} importing`,
    summary.queued > 0 && `${summary.queued} queued`,
    summary.succeeded > 0 && `${summary.succeeded} imported`,
    summary.failed > 0 && `${summary.failed} failed`,
    summary.unknown > 0 && `${summary.unknown} need checking`,
  ].filter(Boolean);
  return { ...summary, text: parts.join(' · ') };
}

function StatusGlyph({ job }: { job: PrImportJob }) {
  switch (job.status) {
    case 'running':
      return <Spinner size={14} label="Importing" showLabel={false} />;
    case 'succeeded':
      return <CheckIcon size={13} />;
    case 'failed':
    case 'unknown':
      return <WarningIcon size={13} />;
    default:
      return <ClockIcon size={13} />;
  }
}

/**
 * Compact, persistent left-panel status for background pull-request imports.
 * Renders nothing when there are none. Mount it once, outside any collapsible
 * tree node, so it outlives the picker dialog and folder collapse.
 */
export function PrImportStatus({
  onOpen,
  onOpenBatch,
  api,
  store = prImportStore,
}: {
  /** Open the imported pull request's review. */
  onOpen?: (job: PrImportJob) => void;
  /** Open the "Bulk PR Review" dashboard for a batch's imported pull requests. */
  onOpenBatch?: (batch: PrImportBatch, jobs: PrImportJob[]) => void;
  /** Lets imports restored after a reload be retried or re-checked. */
  api?: PrImportApi;
  store?: PrImportStore;
}) {
  const jobs = usePrImports(store);
  useEffect(() => {
    if (api) store.bindApi(api);
  }, [api, store]);
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const working = jobs.some((job) => job.status === 'running');
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, [working]);

  const summary = useMemo(() => summarizeImports(jobs), [jobs]);
  if (jobs.length === 0) return null;

  const settled = jobs.filter((job) => job.status !== 'queued' && job.status !== 'running').length;
  const pct = Math.round((settled / jobs.length) * 100);
  const attention = summary.failed + summary.unknown > 0;
  const hasFinished = jobs.some((job) => isFinishedImport(job.status));
  const batchIds = [...new Set(jobs.map((job) => job.batchId))];
  const state = summary.failed ? 'failed' : summary.unknown ? 'unknown' : summary.running ? 'running'
    : summary.queued ? 'queued' : summary.succeeded ? 'succeeded' : 'cancelled';

  return (
    <section
      className={`pr-import-status${attention ? ' has-attention' : ''}`}
      aria-label="Pull request imports"
      data-state={state}
      data-active={working}
    >
      <div className="pr-import-head">
        <button
          type="button"
          className="pr-import-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
          <span className="pr-import-heading-icon"><PullRequestIcon size={16} /></span>
          <span className="pr-import-heading">
            <span className="pr-import-title">PR imports</span>
            <span className="pr-import-summary">{summary.text || 'Done'}</span>
          </span>
        </button>
        {hasFinished && (
          <button
            type="button"
            className="pr-import-action"
            onClick={() => store.clearFinished()}
            title="Remove finished imports from this list"
          >
            Clear
          </button>
        )}
      </div>
      <div className="pr-import-progress-caption">
        <span>Import progress</span>
        <span>{settled} / {jobs.length} finished</span>
      </div>
      <div
        className="pr-import-bar"
        role="progressbar"
        aria-label="Pull request import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${settled} of ${jobs.length} finished`}
      >
        <span className="pr-import-bar-fill" style={{ width: `${pct}%` }} />
        {working && <span className="pr-import-bar-activity" aria-hidden="true" style={{ left: `${pct}%` }} />}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {summary.text}
      </span>
      {expanded && (
        <>
          <ul className="pr-import-list">
            {jobs.map((job) => {
              const stalled =
                job.status === 'running' && now - job.updatedAt >= PR_IMPORT_STALL_MS;
              return (
                <li key={job.id} className={`pr-import-row is-${job.status}`}>
                  <span className="pr-import-glyph" aria-hidden="true">
                    <StatusGlyph job={job} />
                  </span>
                  <span className="pr-import-main">
                    <span className="pr-import-name" title={`${job.repoName} #${job.number} ${job.title}`}>
                      <span className="pr-import-number">#{job.number}</span> {job.title}
                    </span>
                    <span className="pr-import-detail" title={job.error ?? job.message}>
                      {job.error ?? job.message}
                      {stalled &&
                        ` — no update for ${Math.floor((now - job.updatedAt) / 60_000)}m, still working on the server`}
                    </span>
                  </span>
                  <span className="pr-import-actions">
                    {job.status === 'queued' && (
                      <button
                        type="button"
                        className="pr-import-action"
                        onClick={() => store.cancel(job.id)}
                        aria-label={`Cancel import of PR #${job.number}`}
                      >
                        Cancel
                      </button>
                    )}
                    {(job.status === 'failed' || job.status === 'unknown') && (
                      <button
                        type="button"
                        className="pr-import-action"
                        onClick={() => store.retry(job.id)}
                        aria-label={`${job.status === 'failed' ? 'Retry' : 'Check again'} PR #${job.number}`}
                      >
                        <RefreshIcon size={11} /> {job.status === 'failed' ? 'Retry' : 'Check again'}
                      </button>
                    )}
                    {job.status === 'succeeded' && onOpen && (
                      <button
                        type="button"
                        className="pr-import-action"
                        onClick={() => onOpen(job)}
                        aria-label={`Open review for PR #${job.number}`}
                      >
                        Open
                      </button>
                    )}
                    {job.status !== 'queued' && job.status !== 'running' && (
                      <button
                        type="button"
                        className="pr-import-dismiss"
                        onClick={() => store.dismiss(job.id)}
                        aria-label={`Dismiss PR #${job.number}`}
                      >
                        <CloseIcon size={11} />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {onOpenBatch &&
            batchIds.map((batchId) => {
              const batch = store.getBatch(batchId);
              const done = jobs.filter((job) => job.batchId === batchId && job.status === 'succeeded');
              if (!batch?.parent || done.length === 0 || done[0].batchSize < 2) return null;
              return (
                <button
                  key={batchId}
                  type="button"
                  className="pr-import-action pr-import-batch"
                  onClick={() => onOpenBatch(batch, done)}
                >
                  Open {batch.repoName} review dashboard ({done.length}/{done[0].batchSize})
                </button>
              );
            })}
        </>
      )}
    </section>
  );
}
