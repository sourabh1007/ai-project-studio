import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { useState } from 'react';
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
export function WorktreesSection() {
  const api = useApi();
  const { data, loading, error, cause, reload } = useAsync(
    () => api.listWorktrees(),
    [],
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

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

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge icon={<RepoIcon size={22} />} tone="neutral" />
          <div>
            <h2 className="page-title">Review worktrees</h2>
            <p className="page-subtitle">
              Isolated git checkouts the app created under{' '}
              <code>.ai-worktrees</code> for PR reviews. Remove any you no longer
              need to reclaim disk space.
            </p>
          </div>
        </div>
        <Button variant="ghost" onClick={reload} disabled={loading}>
          Refresh
        </Button>
      </div>
      {loading && <Loader label="Loading worktrees" />}
      {error && <ErrorState error={cause ?? error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState message="No review worktrees on disk." />
      )}
      <ErrorText error={removeError} />
      {data && data.length > 0 && (
        <ul className="worktree-list">
          {data.map((wt) => (
            <li key={wt.path} className="worktree-row">
              <div className="worktree-info">
                <span className="worktree-repo">
                  {wt.repoName}
                  {wt.pullNumber !== null && (
                    <span className="worktree-pr"> · PR #{wt.pullNumber}</span>
                  )}
                  {wt.branch && (
                    <span className="worktree-branch"> · {wt.branch}</span>
                  )}
                </span>
                <span className="worktree-path">{wt.path}</span>
              </div>
              <Button
                variant="ghost"
                onClick={() => void remove(wt.path)}
                disabled={removing !== null}
              >
                <TrashIcon size={13} />{' '}
                {removing === wt.path ? 'Removing…' : 'Remove'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
