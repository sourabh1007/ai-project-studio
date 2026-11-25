import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { usePrImports } from '../../hooks/use-pr-imports.js';
import type {
  RemotePullRequest,
  RepoProvider,
  Repository,
  ReviewImportOptions,
  ReviewOptions,
  MetaModelOption,
  Skill,
} from '../../lib/types.js';
import { Button, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { Avatar } from '../../components/avatar.js';
import { Loader, Spinner } from '../../components/loading.js';
import { CheckIcon, CloseIcon, PlusIcon } from '../../components/icons.js';
import { AutomationReadinessNotice, useAutomationReadiness } from '../../app/automation-readiness.js';
import {
  addTeamMember,
  isTeamMember,
  loadTeamRoster,
  removeTeamMember,
  removeTeamMemberByIdentity,
  saveTeamRoster,
} from '../../lib/team-roster.js';
import {
  compareByReviewAge,
  formatReviewAge,
  oldestCreatedAt,
  type ReviewAgeOrder,
} from '../../lib/pr-review-age.js';

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
  importOptions?: ReviewImportOptions;
}

const IMPORT_PERSPECTIVES = [
  ['problem-solution', 'Problem / solution'], ['business', 'Business'],
  ['architecture', 'Architecture'], ['impact-blast-radius', 'Impact / blast radius'],
  ['code-quality', 'Code quality'], ['performance', 'Performance'],
  ['observability', 'Observability'], ['configuration', 'Configuration'],
  ['api-contract', 'API contract'], ['accessibility', 'Accessibility'],
  ['backward-compatibility', 'Backward compatibility'], ['data-contract', 'Data contract'],
  ['rollback-safety', 'Rollback safety'], ['deployment', 'Deployment'],
  ['testing', 'Testing'], ['security', 'Security'], ['final-decision', 'Final decision'],
] as const;

/**
 * Modal for starting a PR review. Lists the repository's open pull requests
 * (with a paste-a-number/URL fallback) and lets the reviewer stage between one
 * and {@link MAX_BULK_PRS} of them. Confirming hands the selection to
 * `onConfirm`, which only queues the import (see `prImportStore`) and closes
 * the dialog: checkouts run in the background and report in the explorer's
 * import status, so this dialog never blocks the UI while they work.
 */
export function PrReviewPicker({
  repo,
  onClose,
  onConfirm,
}: {
  repo: Repository;
  onClose: () => void;
  onConfirm: (pulls: SelectedPull[]) => void | Promise<void>;
}) {
  const api = useApi();
  const automation = useAutomationReadiness();
  const [autoReview, setAutoReview] = useState(true);
  const reviewAfterImport = automation?.canAttempt !== false && autoReview;
  const [reviewOptions, setReviewOptions] = useState<ReviewOptions>({});
  const [setupOpen, setSetupOpen] = useState(false);
  const [models, setModels] = useState<MetaModelOption[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => {
    if (!setupOpen) return;
    let active = true;
    void Promise.allSettled([api.getMetaModels(), api.listSkills()]).then(([catalog, instructions]) => {
      if (!active) return;
      if (catalog.status === 'fulfilled') setModels(catalog.value);
      if (instructions.status === 'fulfilled') setSkills(instructions.value.filter((skill) => skill.kind === 'instruction'));
      if (catalog.status === 'rejected' || instructions.status === 'rejected') {
        setSetupError('Some review options could not be loaded. Close and reopen setup to retry.');
      } else setSetupError(null);
    });
    return () => { active = false; };
  }, [api, setupOpen]);
  function toggleOption(key: 'perspectiveIds' | 'skillIds', id: string) {
    setReviewOptions((options) => {
      const current = options[key] ?? [];
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      const updated = { ...options, [key]: next };
      if (key === 'perspectiveIds' && next.length === 0) delete updated.perspectiveIds;
      return updated;
    });
  }
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
  const imports = usePrImports();
  // Pull requests of this repo that are already queued, running, unresolved or
  // imported, so they cannot be staged (and imported) a second time.
  const importing = useMemo(
    () =>
      new Map(
        imports
          .filter(
            (job) =>
              job.repoId === repo.id &&
              job.status !== 'failed' &&
              job.status !== 'cancelled',
          )
          .map((job) => [job.number, job.status] as const),
      ),
    [imports, repo.id],
  );
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'mine' | 'assigned' | 'all' | 'team'>('all');
  const [selected, setSelected] = useState<SelectedPull[]>([]);
  // The user's saved "team" — an explicit roster of teammate names, loaded from
  // localStorage so it persists across restarts. When set, the Team tab shows
  // only these people's PRs; when empty, it shows everyone so the reviewer can
  // build their team by adding authors they see.
  const [roster, setRoster] = useState<string[]>(() =>
    loadTeamRoster(window.localStorage),
  );
  const [memberDraft, setMemberDraft] = useState('');
  // How the Team tab orders each teammate's PRs — longest-in-review first by
  // default so the most stale reviews surface at the top.
  const [teamOrder, setTeamOrder] = useState<ReviewAgeOrder>('longest');
  // A coarse clock that advances once a minute so the "in review for" labels
  // stay fresh while the picker is open, without re-rendering constantly.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    saveTeamRoster(window.localStorage, roster);
  }, [roster]);
  const addMember = (name: string) =>
    setRoster((prev) => addTeamMember(prev, name));
  const removeMember = (name: string) =>
    setRoster((prev) => removeTeamMember(prev, name));
  const removeMemberIdentity = (
    author: string | null | undefined,
    login: string | null | undefined,
  ) => setRoster((prev) => removeTeamMemberByIdentity(prev, { author, login }));

  const pulls = tab === 'mine' ? mine : tab === 'assigned' ? assigned : everything;
  const list = pulls.data ?? [];
  const counts = {
    mine: mine.data?.length ?? 0,
    assigned: assigned.data?.length ?? 0,
    all: everything.data?.length ?? 0,
  };
  // Distinct teammate handles across the repo's open pull requests, sorted — the
  // suggestion pool for adding teammates. Prefer the git username (login) when
  // the provider exposes it so the roster is configured against the stable
  // handle GitHub users know, falling back to the display name otherwise.
  const knownAuthors = useMemo(
    () =>
      [
        ...new Set(
          (everything.data ?? []).map(
            (pr) => pr.authorLogin ?? pr.author ?? 'Unknown author',
          ),
        ),
      ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    [everything.data],
  );
  // The Team tab shows the configured roster's members; until one is set it
  // falls back to every distinct author so the tab is useful out of the box.
  const teamCount = roster.length > 0 ? roster.length : knownAuthors.length;

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
  // each team member's open work renders as its own group. When a roster is
  // configured, only rostered members' groups are shown; otherwise every author
  // is shown so the reviewer can pick teammates to save.
  const teamGroups = useMemo(() => {
    const map = new Map<string, RemotePullRequest[]>();
    for (const pr of filtered) {
      const key = pr.author ?? 'Unknown author';
      if (roster.length > 0 && !isTeamMember(roster, key, pr.authorLogin)) {
        continue;
      }
      const bucket = map.get(key) ?? [];
      bucket.push(pr);
      map.set(key, bucket);
    }
    // Order each member's PRs by time in review, then order members by their
    // longest-waiting PR so the most stale review work floats to the top.
    for (const bucket of map.values()) {
      bucket.sort((a, b) =>
        compareByReviewAge(a.createdAt, b.createdAt, teamOrder, now),
      );
    }
    return [...map.entries()].sort((a, b) =>
      compareByReviewAge(
        oldestCreatedAt(a[1]),
        oldestCreatedAt(b[1]),
        teamOrder,
        now,
      ),
    );
  }, [filtered, roster, teamOrder, now]);

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
    if (importing.has(number)) {
      setError(`PR #${number} is already imported or importing.`);
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
    try {
      await onConfirm(reviewAfterImport && Object.keys(reviewOptions).length === 0 ? selected :
        selected.map((pull) => ({
          ...pull, importOptions: structuredClone({ autoReview: reviewAfterImport, reviewOptions }),
        })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const renderItem = (pr: RemotePullRequest, showAge = false) => {
    const isSelected = selectedNumbers.has(pr.number);
    const importState = importing.get(pr.number);
    const age = showAge ? formatReviewAge(pr.createdAt, now) : null;
    return (
      <button
        type="button"
        key={pr.number}
        className={`pr-list-item ${isSelected ? 'is-selected' : ''}`.trim()}
        onClick={() => togglePull(pr)}
        disabled={busy || importState !== undefined || (!isSelected && atLimit)}
        title={pr.url}
        aria-pressed={isSelected}
      >
        <span className={`pr-check ${isSelected ? 'is-on' : ''}`.trim()}>
          {isSelected && <CheckIcon size={12} />}
        </span>
        <span className="pr-number">#{pr.number}</span>
        <Avatar name={pr.author} avatarUrl={pr.authorAvatarUrl} size={22} />
        <span className="pr-list-main">
          <span className="pr-title">{pr.title}</span>
          <span className="pr-meta">
            {pr.sourceBranch}
            {pr.author ? ` · ${pr.author}` : ''}
          </span>
        </span>
        {importState && (
          <span className="pr-review-age">
            {importState === 'succeeded' ? 'Imported' : 'Importing…'}
          </span>
        )}
        {age && (
          <span
            className="pr-review-age"
            title={`In review for ${age}${
              pr.createdAt ? ` · opened ${new Date(pr.createdAt).toLocaleString()}` : ''
            }`}
          >
            {age}
          </span>
        )}
      </button>
    );
  };

  return (
    <Modal
      title={`Open Pull Request · ${repo.name}`}
      size={tab === 'team' ? 'xl' : 'md'}
      onClose={onClose}
    >
      <div className="pr-picker">
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
        {tab === 'team' && !pulls.loading && !pulls.error && (
          <div className="pr-team-config">
            <div className="pr-team-config-head">
              <span className="pr-team-config-title">My team</span>
              <span className="pr-team-config-hint">
                {roster.length > 0
                  ? 'The Team tab shows only these teammates’ open PRs. Saved for next time.'
                  : 'Add teammates to save your team and see only their PRs. Showing everyone until you do.'}
              </span>
              <div
                className="pr-team-sort"
                role="group"
                aria-label="Order pull requests by time in review"
              >
                <span className="pr-team-sort-label">Sort</span>
                <button
                  type="button"
                  className={`pr-team-sort-btn ${teamOrder === 'longest' ? 'is-active' : ''}`.trim()}
                  aria-pressed={teamOrder === 'longest'}
                  onClick={() => setTeamOrder('longest')}
                  title="Show the longest-waiting pull requests first"
                >
                  Longest in review
                </button>
                <button
                  type="button"
                  className={`pr-team-sort-btn ${teamOrder === 'newest' ? 'is-active' : ''}`.trim()}
                  aria-pressed={teamOrder === 'newest'}
                  onClick={() => setTeamOrder('newest')}
                  title="Show the most recently opened pull requests first"
                >
                  Newest
                </button>
              </div>
            </div>
            {roster.length > 0 && (
              <ul className="pr-team-chips">
                {roster.map((member) => (
                  <li key={member} className="pr-team-chip">
                    <Avatar name={member} size={16} />
                    <span className="pr-team-chip-name">{member}</span>
                    <button
                      type="button"
                      className="pr-team-chip-remove"
                      aria-label={`Remove ${member} from my team`}
                      onClick={() => removeMember(member)}
                    >
                      <CloseIcon size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="pr-team-add-row">
              <input
                className="input"
                list="pr-team-author-suggestions"
                value={memberDraft}
                onChange={(e) => setMemberDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && memberDraft.trim()) {
                    addMember(memberDraft);
                    setMemberDraft('');
                  }
                }}
                placeholder="Add a teammate by git username or name"
                spellCheck={false}
                aria-label="Add a teammate by git username or name"
              />
              <datalist id="pr-team-author-suggestions">
                {knownAuthors.map((author) => (
                  <option key={author} value={author} />
                ))}
              </datalist>
              <Button
                variant="secondary"
                onClick={() => {
                  if (memberDraft.trim()) {
                    addMember(memberDraft);
                    setMemberDraft('');
                  }
                }}
                disabled={!memberDraft.trim()}
              >
                <PlusIcon size={14} /> Add
              </Button>
            </div>
          </div>
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
            ? teamGroups.length === 0
              ? (
                filtered.length > 0 && (
                  <EmptyState
                    message={
                      roster.length > 0
                        ? 'None of your teammates have matching open pull requests.'
                        : 'No open pull requests found.'
                    }
                  />
                )
              )
              : teamGroups.map(([author, prs]) => {
                  const login = prs[0]?.authorLogin ?? null;
                  const onTeam = isTeamMember(roster, author, login);
                  // Save the git username when available so the roster holds the
                  // stable handle rather than a mutable display name.
                  const handle = login ?? author;
                  return (
                    <div key={author} className="pr-team-group">
                      <div className="pr-team-group-head">
                        <Avatar
                          name={author}
                          avatarUrl={prs[0]?.authorAvatarUrl}
                          size={24}
                        />
                        <span className="pr-team-group-name">{author}</span>
                        <span className="pr-team-group-count">
                          {prs.length} PR{prs.length === 1 ? '' : 's'}
                        </span>
                        <button
                          type="button"
                          className={`pr-team-toggle ${onTeam ? 'is-on' : ''}`.trim()}
                          onClick={() =>
                            onTeam
                              ? removeMemberIdentity(author, login)
                              : addMember(handle)
                          }
                          title={
                            onTeam
                              ? `Remove ${author} from my team`
                              : `Add ${author} to my team`
                          }
                        >
                          {onTeam ? (
                            <>
                              <CheckIcon size={12} /> On team
                            </>
                          ) : (
                            <>
                              <PlusIcon size={12} /> Add
                            </>
                          )}
                        </button>
                      </div>
                      {prs.map((pr) => renderItem(pr, true))}
                    </div>
                  );
                })
            : filtered.map((pr) => renderItem(pr))}
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
        {automation?.canAttempt !== false && <label>
          <input type="checkbox" checked={autoReview} disabled={busy}
            onChange={(event) => setAutoReview(event.target.checked)} />
          Automatically review after import
        </label>}
        {!reviewAfterImport && <p>Import only; review later. No AI runs until you explicitly prepare or start the review.</p>}
        {automation?.canAttempt !== false && <details onToggle={(event) => setSetupOpen(event.currentTarget.open)}>
          <summary>Review setup · applies separately to each selected PR</summary>
          <label>Review model
            <select aria-label="Import review model" disabled={busy} value={reviewOptions.model ?? ''}
              onChange={(event) => setReviewOptions((options) => {
                const next = { ...options };
                if (event.target.value) next.model = event.target.value;
                else delete next.model;
                return next;
              })}>
              <option value="">Use IDE default</option>
              {models.map((model) => <option key={model.id} value={model.id} disabled={!model.enabled}>{model.name}</option>)}
            </select>
          </label>
          <fieldset disabled={busy}><legend>Review perspectives</legend>
            <label>Perspective preset
              <select aria-label="Import perspective preset"
                value={!reviewOptions.perspectiveIds ? 'automatic' :
                  reviewOptions.perspectiveIds.length === IMPORT_PERSPECTIVES.length ? 'all' :
                    reviewOptions.perspectiveIds.length === 1 && reviewOptions.perspectiveIds[0] === 'security' ? 'security' : 'custom'}
                onChange={(event) => {
                  const preset = event.target.value;
                  setReviewOptions(({ perspectiveIds: _ids, ...options }) => ({
                    ...options,
                    ...(preset === 'all' ? { perspectiveIds: IMPORT_PERSPECTIVES.map(([id]) => id) } :
                      preset === 'security' ? { perspectiveIds: ['security'] } : {}),
                  }));
                }}>
                <option value="automatic">Automatically select perspectives</option>
                <option value="security">Security focused</option>
                <option value="all">All perspectives</option>
                <option value="custom" disabled>Custom selection</option>
              </select>
            </label>
            {IMPORT_PERSPECTIVES.map(([id, name]) => <label key={id}>
              <input type="checkbox" checked={reviewOptions.perspectiveIds?.includes(id) ?? false}
                onChange={() => toggleOption('perspectiveIds', id)} />{name}
            </label>)}
          </fieldset>
          <fieldset disabled={busy}><legend>Studio instruction skills</legend>
            {skills.length === 0 && <p>No instruction skills available. Repository guidance is collected automatically.</p>}
            {skills.map((skill) => <label key={skill.id}>
              <input type="checkbox" checked={reviewOptions.skillIds?.includes(skill.id) ?? false}
                onChange={() => toggleOption('skillIds', skill.id)} />{skill.name}
            </label>)}
          </fieldset>
          <label>Business context
            <textarea aria-label="Import business context" rows={3} maxLength={20_000}
              value={reviewOptions.businessContext ?? ''} disabled={busy}
              onChange={(event) => setReviewOptions((options) => ({ ...options, businessContext: event.target.value }))} />
          </label>
          {setupError && <p role="status">{setupError}</p>}
        </details>}
        <AutomationReadinessNotice />

        <div className="pr-picker-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy || selected.length === 0}>
            {busy ? (
              <Spinner size={13} label="Preparing" />
            ) : (
              `${reviewAfterImport ? 'Start review' : 'Import only; review later'}${selected.length > 0 ? ` (${selected.length})` : ''}`
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
