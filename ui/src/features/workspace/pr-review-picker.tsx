import { useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { Feature, RemotePullRequest, Repository } from '../../lib/types.js';
import { Button, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { Loader, Spinner } from '../../components/loading.js';

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
  const mine = useAsync<RemotePullRequest[]>(
    () => api.listRepoPulls(repo.id, 'mine'),
    [repo.id],
  );
  const assigned = useAsync<RemotePullRequest[]>(
    () => api.listRepoPulls(repo.id, 'assigned'),
    [repo.id],
  );
  const everything = useAsync<RemotePullRequest[]>(
    () => api.listRepoPulls(repo.id, 'all'),
    [repo.id],
  );
  const [manual, setManual] = useState('');
  const [busyNumber, setBusyNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'mine' | 'assigned' | 'all'>('all');

  const busy = busyNumber !== null;

  const pulls = tab === 'mine' ? mine : tab === 'assigned' ? assigned : everything;
  const list = pulls.data ?? [];
  const counts = {
    mine: mine.data?.length ?? 0,
    assigned: assigned.data?.length ?? 0,
    all: everything.data?.length ?? 0,
  };

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
        {busy && (
          <div className="pr-checkout-overlay" role="status" aria-live="polite">
            <span className="spinner spinner-lg" aria-hidden="true" />
            <div className="pr-checkout-title">
              Checking out&nbsp;<strong>#{busyNumber}</strong>
            </div>
            <div className="pr-checkout-sub">
              Preparing an isolated review worktree. Large repositories can take
              a minute the first time…
            </div>
            <span className="pr-checkout-bar" aria-hidden="true" />
          </div>
        )}
        <div className="pr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mine'}
            className={`pr-tab ${tab === 'mine' ? 'is-active' : ''}`}
            onClick={() => setTab('mine')}
          >
            My PRs
            {mine.loading ? (
              <Spinner size={11} label="Loading" />
            ) : (
              <span className="pr-tab-count">{counts.mine}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'assigned'}
            className={`pr-tab ${tab === 'assigned' ? 'is-active' : ''}`}
            onClick={() => setTab('assigned')}
          >
            Assigned to me
            {assigned.loading ? (
              <Spinner size={11} label="Loading" />
            ) : (
              <span className="pr-tab-count">{counts.assigned}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            className={`pr-tab ${tab === 'all' ? 'is-active' : ''}`}
            onClick={() => setTab('all')}
          >
            All PRs
            {everything.loading ? (
              <Spinner size={11} label="Loading" />
            ) : (
              <span className="pr-tab-count">{counts.all}</span>
            )}
          </button>
        </div>
        {!pulls.loading && !pulls.error && (pulls.data?.length ?? 0) > 0 && (
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
          {!pulls.loading &&
            !pulls.error &&
            (pulls.data?.length ?? 0) === 0 && (
              <EmptyState
                message={
                  tab === 'mine'
                    ? 'You have no open pull requests here.'
                    : tab === 'assigned'
                      ? 'No pull requests are awaiting your review.'
                      : 'No open pull requests found.'
                }
              />
            )}
          {!pulls.loading &&
            !pulls.error &&
            (pulls.data?.length ?? 0) > 0 &&
            filtered.length === 0 && (
              <EmptyState message="No pull requests match your search." />
            )}
          {filtered.map((pr) => (
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
                <Spinner size={14} label="Checking out" />
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
              {busy ? <Spinner size={13} label="Checking out" /> : 'Review'}
            </Button>
          </div>
        </div>

        <ErrorText error={error} />
      </div>
    </Modal>
  );
}
