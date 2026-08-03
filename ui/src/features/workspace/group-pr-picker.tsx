import { useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { RemotePullRequest } from '../../lib/types.js';
import { EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';

/** The pull request chosen to attach as a group under a feature. */
export interface PickedPull {
  number: number;
  title: string;
  url: string;
}

/**
 * Modal for attaching an existing pull request to a feature as an organizational
 * `pr` group. Unlike the PR *review* flow, this does not check out a worktree —
 * it only records the PR so sessions can be grouped beneath it.
 */
export function GroupPrPicker({
  repoId,
  onClose,
  onPick,
}: {
  repoId: string;
  onClose: () => void;
  onPick: (pull: PickedPull) => void;
}) {
  const api = useApi();
  const pulls = useAsync<RemotePullRequest[]>(
    () => api.listRepoPulls(repoId, 'all'),
    [repoId],
  );
  const [query, setQuery] = useState('');

  const list = pulls.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return list;
    }
    return list.filter((pr) =>
      [`#${pr.number}`, String(pr.number), pr.title, pr.sourceBranch, pr.author ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [list, query]);

  return (
    <Modal title="Attach a pull request" onClose={onClose}>
      <div className="pr-picker">
        {!pulls.loading && !pulls.error && list.length > 0 && (
          <input
            className="input pr-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pull requests by number, title, branch or author"
            spellCheck={false}
            aria-label="Search pull requests"
          />
        )}
        <div className="pr-list">
          {pulls.loading && <Loader label="Loading pull requests" />}
          <ErrorText error={pulls.error} />
          {!pulls.loading && !pulls.error && list.length === 0 && (
            <EmptyState message="No open pull requests found." />
          )}
          {!pulls.loading && !pulls.error && list.length > 0 && filtered.length === 0 && (
            <EmptyState message="No pull requests match your search." />
          )}
          {filtered.map((pr) => (
            <button
              type="button"
              key={pr.number}
              className="pr-list-item"
              onClick={() =>
                onPick({ number: pr.number, title: pr.title, url: pr.url })
              }
              title={pr.url}
            >
              <span className="pr-number">#{pr.number}</span>
              <span className="pr-list-main">
                <span className="pr-title">{pr.title}</span>
                <span className="pr-meta">
                  {pr.sourceBranch}
                  {pr.author ? ` · ${pr.author}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
