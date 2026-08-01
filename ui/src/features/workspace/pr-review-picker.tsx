import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { Feature, RemotePullRequest, Repository } from '../../lib/types.js';
import { Button, EmptyState, ErrorText, Modal } from '../../components/ui.js';

/**
 * Extracts a pull-request number from a pasted value — either a bare number or
 * a provider URL (GitHub `/pull/42`, Azure `/pullrequest/42`). The last integer
 * in the string is the PR id in every provider URL shape we support.
 */
export function parsePullNumber(input: string): number | null {
  const matches = input.match(/\d+/g);
  if (!matches) {
    return null;
  }
  const n = Number(matches[matches.length - 1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Modal for starting a PR review. Lists the repository's open pull requests
 * (with a paste-a-number/URL fallback); picking one asks the backend to check
 * the branch out into a git worktree and create a feature for it. Multiple PRs
 * can be reviewed concurrently since each lands in its own worktree.
 */
export function PrReviewPicker({
  repo,
  onClose,
  onCreated,
}: {
  repo: Repository;
  onClose: () => void;
  onCreated: (feature: Feature) => void;
}) {
  const api = useApi();
  const pulls = useAsync<RemotePullRequest[]>(
    () => api.listRepoPulls(repo.id),
    [repo.id],
  );
  const [manual, setManual] = useState('');
  const [busyNumber, setBusyNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = busyNumber !== null;

  async function review(number: number) {
    setBusyNumber(number);
    setError(null);
    try {
      const feature = await api.createPrFeature(repo.id, number);
      onCreated(feature);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyNumber(null);
    }
  }

  function reviewManual() {
    const number = parsePullNumber(manual);
    if (!number) {
      setError('Enter a valid pull request number or URL.');
      return;
    }
    void review(number);
  }

  return (
    <Modal title={`Review a pull request · ${repo.name}`} onClose={onClose}>
      <div className="pr-picker">
        <div className="pr-list">
          {pulls.loading && <EmptyState message="Loading pull requests…" />}
          <ErrorText error={pulls.error} />
          {!pulls.loading &&
            !pulls.error &&
            (pulls.data?.length ?? 0) === 0 && (
              <EmptyState message="No open pull requests found." />
            )}
          {pulls.data?.map((pr) => (
            <button
              type="button"
              key={pr.number}
              className="pr-list-item"
              onClick={() => void review(pr.number)}
              disabled={busy}
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
              {busyNumber === pr.number && (
                <span className="pr-busy">Checking out…</span>
              )}
            </button>
          ))}
        </div>

        <div className="pr-manual">
          <label htmlFor="pr-manual-input">Or paste a PR number or URL</label>
          <div className="pr-manual-row">
            <input
              id="pr-manual-input"
              className="input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  reviewManual();
                }
              }}
              placeholder="e.g. 42 or https://github.com/o/r/pull/42"
              spellCheck={false}
              disabled={busy}
            />
            <Button onClick={reviewManual} disabled={busy || !manual.trim()}>
              {busy ? 'Checking out…' : 'Review'}
            </Button>
          </div>
        </div>

        <ErrorText error={error} />
      </div>
    </Modal>
  );
}
