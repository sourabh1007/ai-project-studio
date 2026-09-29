import { useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type {
  RemotePullRequest,
  RepoProvider,
  Repository,
} from '../../lib/types.js';
import { Button, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { Loader, Spinner } from '../../components/loading.js';
import { CheckIcon, CloseIcon, PlusIcon } from '../../components/icons.js';

/**
 * Extracts a pull-request number from a pasted value — either a bare number or
 * a provider URL (GitHub `/pull/42`, Azure `/pullrequest/42`). Query strings
 * and fragments are ignored, so comment anchors or numeric search params never
 * override the provider-native PR id.
 */
export function parsePullNumber(
  input: string,
  provider: RepoProvider,
): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const number = Number(trimmed);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const number =
    provider === 'github'
      ? parseGithubPullNumber(segments)
      : parseAzurePullNumber(segments);
  return number !== null && Number.isSafeInteger(number) && number > 0
    ? number
    : null;
}

function parseGithubPullNumber(segments: readonly string[]): number | null {
  const pullIndex = segments.findIndex((segment) => segment === 'pull');
  if (pullIndex < 0 || pullIndex + 1 >= segments.length) {
    return null;
  }
  return parsePositiveInteger(segments[pullIndex + 1]);
}

function parseAzurePullNumber(segments: readonly string[]): number | null {
  const pullIndex = segments.findIndex((segment) => segment === 'pullrequest');
  if (pullIndex < 0 || pullIndex + 1 >= segments.length) {
    return null;
  }
  return parsePositiveInteger(segments[pullIndex + 1]);
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** The maximum number of pull requests reviewable together in one batch. */
export const MAX_BULK_PRS = 10;

/** A pull request the reviewer has staged for the batch. */
export interface SelectedPull {
  number: number;
  title: string;
}

/**
 * Modal for starting a PR review. Lists the repository's open pull requests
 * (with a paste-a-number/URL fallback) and lets the reviewer stage between one
 * and {@link MAX_BULK_PRS} of them. Confirming hands the selection to
 * `onConfirm`, which creates a "Bulk PR Review" feature, a review worktree per
 * PR, and opens each Review Board plus a live progress tracker.
 */
export function PrReviewPicker({
  repo,
  onClose,
  onConfirm,
}: {
  repo: Repository;
  onClose: () => void;
  onConfirm: (
    pulls: SelectedPull[],
    reportProgress: (message: string) => void,
  ) => Promise<void>;
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
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'mine' | 'assigned' | 'all' | 'team'>('all');
  const [selected, setSelected] = useState<SelectedPull[]>([]);

  const pulls = tab === 'mine' ? mine : tab === 'assigned' ? assigned : everything;
  const list = pulls.data ?? [];
  const counts = {
    mine: mine.data?.length ?? 0,
    assigned: assigned.data?.length ?? 0,
    all: everything.data?.length ?? 0,
  };
  // "Team members" are derived from the distinct authors of the repository's
  // open pull requests — no configuration needed. The Team tab groups every
  // open PR under its author so a reviewer can scan the team's work at a glance.
  const teamCount = useMemo(
    () =>
      new Set((everything.data ?? []).map((pr) => pr.author ?? 'Unknown author'))
        .size,
    [everything.data],
  );

  const selectedNumbers = useMemo(
    () => new Set(selected.map((p) => p.number)),
    [selected],
  );
  const atLimit = selected.length >= MAX_BULK_PRS;

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

  // For the Team tab, cluster the filtered pull requests under their author so
  // each team member's open work renders as its own group.
  const teamGroups = useMemo(() => {
    const map = new Map<string, RemotePullRequest[]>();
    for (const pr of filtered) {
      const key = pr.author ?? 'Unknown author';
      const bucket = map.get(key) ?? [];
      bucket.push(pr);
      map.set(key, bucket);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  function addPull(pull: SelectedPull) {
    setError(null);
    setSelected((prev) => {
      if (prev.some((p) => p.number === pull.number)) {
        return prev;
      }
      if (prev.length >= MAX_BULK_PRS) {
        return prev;
      }
      return [...prev, pull];
    });
  }

  function togglePull(pr: RemotePullRequest) {
    if (selectedNumbers.has(pr.number)) {
      removePull(pr.number);
    } else if (!atLimit) {
      addPull({ number: pr.number, title: pr.title });
    }
  }

  function removePull(number: number) {
    setSelected((prev) => prev.filter((p) => p.number !== number));
  }

  function addManual() {
    const number = parsePullNumber(manual, repo.provider);
    if (!number) {
      setError('Enter a valid pull request number or URL.');
      return;
    }
    if (selectedNumbers.has(number)) {
      setManual('');
      return;
    }
    if (atLimit) {
      setError(`You can review at most ${MAX_BULK_PRS} pull requests at once.`);
      return;
    }
    const known = list.find((pr) => pr.number === number);
    addPull({ number, title: known?.title ?? `PR #${number}` });
    setManual('');
  }

  async function confirm() {
    if (selected.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      await onConfirm(selected, (message) => setProgress(message));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setProgress(null);
    }
  }

  const renderItem = (pr: RemotePullRequest) => {
    const isSelected = selectedNumbers.has(pr.number);
    return (
      <button
        type="button"
        key={pr.number}
        className={`pr-list-item ${isSelected ? 'is-selected' : ''}`.trim()}
        onClick={() => togglePull(pr)}
        disabled={busy || (!isSelected && atLimit)}
        title={pr.url}
        aria-pressed={isSelected}
      >
        <span className={`pr-check ${isSelected ? 'is-on' : ''}`.trim()}>
          {isSelected && <CheckIcon size={12} />}
        </span>
        <span className="pr-number">#{pr.number}</span>
        <span className="pr-list-main">
          <span className="pr-title">{pr.title}</span>
          <span className="pr-meta">
            {pr.sourceBranch}
            {pr.author ? ` · ${pr.author}` : ''}
          </span>
        </span>
      </button>
    );
  };

  return (
    <Modal title={`Open Pull Request · ${repo.name}`} onClose={busy ? () => {} : onClose}>
      <div className="pr-picker">
        {busy && (
          <div className="pr-checkout-overlay" role="status" aria-live="polite">
            <span className="spinner spinner-lg" aria-hidden="true" />
            <div className="pr-checkout-title">
              Preparing&nbsp;<strong>{selected.length}</strong>&nbsp;review
              {selected.length === 1 ? '' : 's'}
            </div>
            <div className="pr-checkout-sub">
              {progress ??
                'Checking out an isolated worktree per pull request. Large ' +
                  'repositories can take a minute the first time…'}
            </div>
            <span className="pr-checkout-bar" aria-hidden="true" />
          </div>
        )}

        {selected.length > 0 && (
          <div className="pr-selected">
            <div className="pr-selected-head">
              <span>Selected pull requests</span>
              <span className="pr-selected-count">
                {selected.length} / {MAX_BULK_PRS}
              </span>
            </div>
            <ul className="pr-chips">
              {selected.map((p) => (
                <li key={p.number} className="pr-chip">
                  <span className="pr-chip-number">#{p.number}</span>
                  <span className="pr-chip-title">{p.title}</span>
                  <button
                    type="button"
                    className="pr-chip-remove"
                    aria-label={`Remove #${p.number}`}
                    onClick={() => removePull(p.number)}
                    disabled={busy}
                  >
                    <CloseIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
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
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'team'}
            className={`pr-tab ${tab === 'team' ? 'is-active' : ''}`}
            onClick={() => setTab('team')}
            title="Open pull requests grouped by team member (author)"
          >
            Team
            {everything.loading ? (
              <Spinner size={11} label="Loading" />
            ) : (
              <span className="pr-tab-count">{teamCount}</span>
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
          {!pulls.loading && !pulls.error && tab === 'team'
            ? teamGroups.map(([author, prs]) => (
                <div key={author} className="pr-team-group">
                  <div className="pr-team-group-head">
                    <span className="pr-team-group-name">{author}</span>
                    <span className="pr-team-group-count">
                      {prs.length} PR{prs.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {prs.map(renderItem)}
                </div>
              ))
            : filtered.map(renderItem)}
        </div>

        <div className="pr-manual">
          <label htmlFor="pr-manual-input">Add by PR number or URL</label>
          <div className="pr-manual-row">
            <input
              id="pr-manual-input"
              className="input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  addManual();
                }
              }}
              placeholder="e.g. 42 or https://github.com/o/r/pull/42"
              spellCheck={false}
              disabled={busy || atLimit}
            />
            <Button
              variant="secondary"
              onClick={addManual}
              disabled={busy || atLimit || !manual.trim()}
            >
              <PlusIcon size={14} /> Add
            </Button>
          </div>
          {atLimit && (
            <p className="pr-limit-hint">
              Maximum of {MAX_BULK_PRS} pull requests reached.
            </p>
          )}
        </div>

        <ErrorText error={error} />

        <div className="pr-picker-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy || selected.length === 0}>
            {busy ? (
              <Spinner size={13} label="Preparing" />
            ) : (
              `Start review${selected.length > 0 ? ` (${selected.length})` : ''}`
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
