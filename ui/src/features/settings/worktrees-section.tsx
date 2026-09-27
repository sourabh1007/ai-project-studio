import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  IconBadge,
} from '../../components/ui.js';
import { RepoIcon, TrashIcon } from '../../components/icons.js';
import { ErrorState } from '../../components/error-state.js';
import { Loader } from '../../components/loading.js';
import type { ManagedWorktree } from '../../lib/types.js';

type Removal = {
  worktree: ManagedWorktree;
  status: 'queued' | 'deleting' | 'error' | 'removed';
  error?: string;
};

/**
 * Lists the git worktrees the app provisioned for PR reviews and lets the user
 * reclaim disk by removing them. Worktrees are also cleaned up automatically
 * when a PR-review feature is deleted; this panel handles orphans.
 */
export function WorktreesSection({ embedded }: { embedded?: boolean } = {}) {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.listWorktrees(),
    [],
  );
  const [removals, setRemovals] = useState<Record<string, Removal>>({});
  const pending = useRef(new Set<string>());
  const queue = useRef<(() => void)[]>([]);
  const active = useRef(0);
  const mounted = useRef(true);
  const embeddedHeadingRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(reload, 3000);
    const refresh = () => reload();
    window.addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [reload]);

  useEffect(() => {
    if (!data) return;
    const listed = new Set(data.map(({ path }) => path));
    setRemovals((previous) => Object.fromEntries(Object.entries(previous).filter(
      ([path, removal]) => removal.status !== 'removed' || listed.has(path),
    )));
  }, [data]);

  useEffect(() => {
    if (!embedded) return;
    const host = embeddedHeadingRef.current?.closest('.settings-collapsible-body');
    if (!host || host.querySelector('[data-embedded-heading="worktrees"]')) return;
    const heading = document.createElement('h2');
    heading.className = 'sr-only';
    heading.dataset.embeddedHeading = 'worktrees';
    heading.textContent = 'Review worktrees';
    host.prepend(heading);
    return () => heading.remove();
  }, [embedded]);

  function remove(worktree: ManagedWorktree) {
    const { path } = worktree;
    if (pending.current.has(path)) return;
    pending.current.add(path);
    const update = (status: Removal['status'], error?: string) => {
      if (mounted.current) setRemovals((previous) => ({
        ...previous, [path]: { worktree, status, error },
      }));
    };
    update('queued');
    const start = async () => {
      active.current += 1;
      update('deleting');
      try {
        await api.removeWorktree(path);
        update('removed');
        if (mounted.current) reload();
      } catch (err) {
        update('error', err instanceof Error ? err.message : String(err));
      } finally {
        pending.current.delete(path);
        active.current -= 1;
        queue.current.shift()?.();
      }
    };
    if (active.current < 3) void start();
    else queue.current.push(() => void start());
  }

  // Keep pending/failed rows visible during refresh; a stale list response must
  // not resurrect a checkout whose removal already completed.
  const rows = new Map(data?.map((worktree) => [worktree.path, worktree]));
  for (const [path, removal] of Object.entries(removals)) {
    if (removal.status === 'removed') rows.delete(path);
    else if (!rows.has(path)) rows.set(path, removal.worktree);
  }

  const body = (
    <>
      {embedded && <span ref={embeddedHeadingRef} hidden />}
      {embedded && (
        <div className="worktree-embedded-head">
          <p className="page-subtitle">
            Isolated git checkouts the app created under{' '}
            <code>.ai-worktrees</code> for code reviews. Remove any you no longer
            need to reclaim disk space.
          </p>
          <Button variant="ghost" onClick={reload} disabled={loading}>
            Refresh
          </Button>
        </div>
      )}
      {loading && !data && <Loader label="Loading worktrees" />}
      {error && <ErrorState error={cause ?? error} onRetry={reload} />}
      {data && rows.size === 0 && (
        <EmptyState message="No review worktrees on disk." />
      )}
      {rows.size > 0 && (
        <ul className="worktree-list">
          {[...rows.values()].map((wt) => {
            const removal = removals[wt.path];
            const remote = wt.removal;
            const busy = removal?.status === 'queued' || removal?.status === 'deleting' ||
              remote?.status === 'queued' || remote?.status === 'deleting';
            const removalError = removal?.error ?? (remote?.status === 'failed' ? remote.message : null);
            const isTask =
              wt.pullNumber === null &&
              (wt.path.includes('-task-') ||
                (wt.branch?.includes('new-task') ?? false));
            return (
              <li key={wt.path} className="worktree-row">
                <span className="worktree-icon" aria-hidden="true">
                  <RepoIcon size={16} />
                </span>
                <div className="worktree-info">
                  <div className="worktree-head">
                    <span className="worktree-repo">{wt.repoName}</span>
                    {wt.pullNumber !== null && (
                      <span className="worktree-badge is-pr">
                        PR #{wt.pullNumber}
                      </span>
                    )}
                    {isTask && (
                      <span className="worktree-badge is-task">New Task</span>
                    )}
                    {wt.branch && (
                      <span className="worktree-branch-chip" title={wt.branch}>
                        {wt.branch}
                      </span>
                    )}
                  </div>
                  <span className="worktree-path" title={wt.path}>
                    {wt.path}
                  </span>
                  {busy && <span role="status" aria-label="Removal status">{remote?.message ??
                    (removal?.status === 'queued' ? 'Queued for removal' : 'Deleting worktree…')}</span>}
                  <ErrorText error={removalError} />
                </div>
                <Button
                  variant="danger"
                  onClick={() => remove(wt)}
                  disabled={busy}
                  loading={removal?.status === 'deleting' || remote?.status === 'deleting'}
                >
                  <TrashIcon size={13} /> {removalError ? 'Retry removal' : 'Remove'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  if (embedded) {
    return body;
  }

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge icon={<RepoIcon size={22} />} tone="neutral" />
          <div>
            <h2 className="page-title">Review worktrees</h2>
            <p className="page-subtitle">
              Isolated git checkouts the app created under{' '}
              <code>.ai-worktrees</code> for code reviews. Remove any you no longer
              need to reclaim disk space.
            </p>
          </div>
        </div>
        <Button variant="ghost" onClick={reload} disabled={loading}>
          Refresh
        </Button>
      </div>
      {body}
    </Card>
  );
}
