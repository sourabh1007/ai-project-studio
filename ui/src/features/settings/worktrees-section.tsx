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
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const embeddedHeadingRef = useRef<HTMLSpanElement | null>(null);

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

  async function remove(path: string) {
    setRemoving(path);
    setRemoveError(null);
    try {
      await api.removeWorktree(path);
      reload();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(null);
    }
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
      {loading && <Loader label="Loading worktrees" />}
      {error && <ErrorState error={cause ?? error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState message="No review worktrees on disk." />
      )}
      <ErrorText error={removeError} />
      {data && data.length > 0 && (
        <ul className="worktree-list">
          {data.map((wt) => {
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
                </div>
                <Button
                  variant="danger"
                  onClick={() => void remove(wt.path)}
                  disabled={removing !== null}
                  loading={removing === wt.path}
                >
                  <TrashIcon size={13} /> Remove
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
