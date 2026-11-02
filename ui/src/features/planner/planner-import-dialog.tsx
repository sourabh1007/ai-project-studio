import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api.js';
import { isDefiniteRejection } from '../../lib/operation-keys.js';
import { ErrorText } from '../../components/ui.js';
import { CloseIcon, ExpandIcon, ImportIcon, RepoIcon, RestoreIcon } from '../../components/icons.js';
import {
  defaultWorkItemFilter,
  isWorkItemFilter,
  issueToTask,
  pullToTask,
  workItemToTask,
  isImportPullScope,
  isImportIssueScope,
  refineImportPulls,
  type ImportPullScope,
} from '../../lib/planner-import.js';
import {
  isStringArray,
  normalizeTeamRoster,
  TEAM_ROSTER_STORAGE_KEY,
} from '../../lib/team-roster.js';
import type { ReviewAgeOrder } from '../../lib/pr-review-age.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import type {
  CreatePlannerTaskInput,
  RemoteWorkItem,
  RepoProvider,
  Repository,
  WorkItemFilter,
  IssueFilter,
  RemotePullRequest,
} from '../../lib/types.js';

/** The subset of the API client the import dialog depends on. */
export type PlannerImportApi = Pick<
  ApiClient,
  | 'listRepoWorkItems'
  | 'listRepoWorkItemComments'
  | 'listRepoIssues'
  | 'listRepoPulls'
  | 'createPlannerTask'
>;

/** A provider source the user can import planner tasks from. */
type ImportSource = 'ado-work-items' | 'ado-prs' | 'gh-issues' | 'gh-prs';

const SOURCES: Array<{
  id: ImportSource;
  label: string;
  provider: RepoProvider;
}> = [
  { id: 'ado-work-items', label: 'ADO Work Items', provider: 'azure-devops' },
  { id: 'ado-prs', label: 'ADO PRs', provider: 'azure-devops' },
  { id: 'gh-issues', label: 'GitHub Issues', provider: 'github' },
  { id: 'gh-prs', label: 'GitHub PRs', provider: 'github' },
];

/** A normalized, selectable import row with its resulting planner task. */
interface ImportRow {
  key: string;
  title: string;
  meta: string;
  task: CreatePlannerTaskInput;
  workItem?: RemoteWorkItem;
  pull?: RemotePullRequest;
}

interface PlannerImportDialogProps {
  api: PlannerImportApi;
  repos: Repository[];
  /** Day the imported tasks land on (`YYYY-MM-DD`). */
  date: string;
  onClose: () => void;
  /** Called with how many tasks were created once an import completes. */
  onImported: (count: number) => void;
  /** Refresh confirmed creates even when a later item fails. */
  onProgress?: (count: number) => void;
}

/** Loads a source's items for a repo and normalizes them into import rows. */
async function loadRows(
  api: PlannerImportApi,
  source: ImportSource,
  repoId: string,
  date: string,
  workItemFilter: WorkItemFilter,
  pullScope: ImportPullScope,
  issueScope: IssueFilter,
): Promise<ImportRow[]> {
  if (source === 'ado-work-items') {
    const items = await api.listRepoWorkItems(repoId, workItemFilter);
    return items.map((item) => ({
      key: `wi-${item.id}`,
      title: item.title,
      meta: [`#${item.id}`, item.type, item.state, item.assignedTo ?? 'Unassigned']
        .filter((p) => p)
        .join(' · '),
      task: workItemToTask(item, repoId, date),
      workItem: item,
    }));
  }
  if (source === 'gh-issues') {
    const items = await api.listRepoIssues(repoId, issueScope);
    return items.map((item) => ({
      key: `issue-${item.number}`,
      title: item.title,
      meta: [`#${item.number}`, item.author ?? 'unknown', ...item.labels]
        .filter((p) => p)
        .join(' · '),
      task: issueToTask(item, repoId, date),
    }));
  }
  const pulls = await api.listRepoPulls(repoId, pullScope === 'team' ? 'all' : pullScope);
  return pulls.map((pull) => ({
    key: `pr-${pull.number}`,
    title: pull.title,
    meta: [`#${pull.number}`, pull.author ?? 'unknown', pull.sourceBranch]
      .filter((p) => p)
      .join(' · '),
    task: pullToTask(pull, repoId, date),
    pull,
  }));
}

/**
 * Modal that imports one or more planner tasks from a repository's provider:
 * Azure DevOps work items / pull requests and GitHub issues / pull requests.
 * The user picks a source and repo, multi-selects items, and adds them as
 * tasks (PRs become launchable `pr` tasks; work items / issues become plain
 * tasks that link back to the source item).
 */
export function PlannerImportDialog({
  api,
  repos,
  date,
  onClose,
  onImported,
  onProgress,
}: PlannerImportDialogProps): JSX.Element {
  const [source, setSource] = useState<ImportSource>('ado-work-items');
  const [expanded, setExpanded] = useState(false);
  const [workItemFilter, setWorkItemFilter] = usePersistentState<WorkItemFilter>(
    'cw-planner-import-wi-filter',
    defaultWorkItemFilter,
    { validate: isWorkItemFilter },
  );
  const [workItemDraft, setWorkItemDraft] = useState(workItemFilter);
  const [adoPullScope, setAdoPullScope] = usePersistentState<ImportPullScope>(
    'cw-planner-import-ado-pr-scope', 'all', { validate: isImportPullScope },
  );
  const [ghPullScope, setGhPullScope] = usePersistentState<ImportPullScope>(
    'cw-planner-import-gh-pr-scope', 'all', { validate: isImportPullScope },
  );
  const [issueScope, setIssueScope] = usePersistentState<IssueFilter>(
    'cw-planner-import-issue-scope', 'all', { validate: isImportIssueScope },
  );
  const [roster, setRoster] = usePersistentState<string[]>(
    TEAM_ROSTER_STORAGE_KEY, [], { validate: isStringArray, normalize: normalizeTeamRoster },
  );
  const [memberDraft, setMemberDraft] = useState('');
  const [order, setOrder] = useState<ReviewAgeOrder>('longest');
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const isPullSource = source === 'ado-prs' || source === 'gh-prs';
  const pullScope = source === 'ado-prs' ? adoPullScope : ghPullScope;
  const setPullScope = source === 'ado-prs' ? setAdoPullScope : setGhPullScope;
  const provider = SOURCES.find((s) => s.id === source)!.provider;
  const eligibleRepos = useMemo(
    () => repos.filter((r) => r.provider === provider),
    [repos, provider],
  );
  const [selectedRepoId, setRepoId] = useState<string | null>(null);
  const repoId = eligibleRepos.find((repo) => repo.id === selectedRepoId)?.id ??
    eligibleRepos[0]?.id ?? null;
  const [loadedRows, setRows] = useState<ImportRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, 'created' | 'unknown'>>({});
  const outcomeKey = (key: string) => `${source}:${repoId}:${key}`;
  const sourceOutcomes = Object.entries(outcomes).filter(([key]) => key.startsWith(`${source}:${repoId}:`));
  const createdCount = sourceOutcomes.filter(([, outcome]) => outcome === 'created').length;
  const unknownCount = sourceOutcomes.filter(([, outcome]) => outcome === 'unknown').length;

  const rows = useMemo(() => {
    const rowsByPull = new Map(loadedRows.map((row) => [row.pull, row]));
    const pulls = isPullSource
      ? refineImportPulls(loadedRows.flatMap((row) => row.pull ? [row.pull] : []), pullScope, roster, order)
      : [];
    const ordered = isPullSource
      ? pulls.map((pull) => rowsByPull.get(pull)!)
      : loadedRows;
    const text = query.trim().toLowerCase();
    return ordered.filter((row) => !outcomes[`${source}:${repoId}:${row.key}`] &&
      `${row.title} ${row.meta} ${row.pull?.authorLogin ?? ''}`.toLowerCase().includes(text));
  }, [loadedRows, isPullSource, pullScope, roster, order, query, outcomes, source, repoId]);

  // Queries and selection belong to the currently displayed source/repository.
  useEffect(() => {
    setQuery('');
    setQueryDraft('');
    setSelected(new Set());
  }, [source, repoId]);

  // Load the chosen source/repo's items whenever either changes.
  useEffect(() => {
    if (!repoId) {
      setRows([]);
      setSelected(new Set());
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setRows([]);
    loadRows(api, source, repoId, date, workItemFilter, pullScope, issueScope)
      .then((loaded) => {
        if (!cancelled) {
          setRows(loaded);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load items.');
          setRows([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, source, repoId, date, workItemFilter, pullScope, issueScope]);

  useEffect(() => {
    setSelected(new Set());
  }, [query, roster]);

  const toggle = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)));
  };

  const addSelected = async (): Promise<void> => {
    const chosen = rows.filter((r) => selected.has(r.key));
    if (chosen.length === 0) {
      return;
    }
    setAdding(true);
    setError(null);
    let created = 0;
    let current: ImportRow | undefined;
    try {
      for (const row of chosen) {
        current = row;
        let task = row.task;
        if (row.workItem && repoId) {
          try {
            const comments = await api.listRepoWorkItemComments(
              repoId,
              row.workItem.id,
            );
            task = workItemToTask(row.workItem, repoId, date, comments);
          } catch {
            // Comments enrich notes but should not block importing the task.
            task = row.task;
          }
        }
        await api.createPlannerTask(task);
        created += 1;
        setOutcomes((previous) => ({ ...previous, [outcomeKey(row.key)]: 'created' }));
        setSelected((previous) => {
          const next = new Set(previous);
          next.delete(row.key);
          return next;
        });
      }
      if (unknownCount === 0) onImported(chosen.length);
    } catch (err) {
      const uncertain = !isDefiniteRejection(err);
      if (uncertain && current) {
        const key = current.key;
        setOutcomes((previous) => ({ ...previous, [outcomeKey(key)]: 'unknown' }));
        setSelected((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }
      setError(`${created} task(s) added. ${err instanceof Error ? err.message : 'Failed to add tasks.'} ${
        uncertain
          ? 'The last task may have been created. Check Planner before importing it again; it is excluded from retry.'
          : 'The rejected task and unattempted tasks can be retried.'
      }`);
    } finally {
      if (current) onProgress?.(created);
      setAdding(false);
    }
  };

  return (
    <div
      className="planner-summary-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className={`planner-summary-modal planner-import-modal${expanded ? ' is-expanded' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Import tasks"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="planner-summary-head">
          <span className="planner-summary-badge">
            <ImportIcon size={16} />
          </span>
          <span className="planner-summary-title">Import tasks</span>
          <div className="planner-summary-head-actions">
            <button
              type="button"
              className="icon-button planner-mini"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? 'Restore size' : 'Expand'}
              aria-pressed={expanded}
              title={expanded ? 'Restore size' : 'Expand'}
            >
              {expanded ? <RestoreIcon size={15} /> : <ExpandIcon size={15} />}
            </button>
            <button
              type="button"
              className="icon-button planner-mini"
              onClick={onClose}
              aria-label="Close import"
              title="Close"
            >
              <CloseIcon size={15} />
            </button>
          </div>
        </div>

        <div className="planner-import-sources" role="tablist">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={source === s.id}
              className={
                source === s.id
                  ? 'planner-import-source is-active'
                  : 'planner-import-source'
              }
              onClick={() => setSource(s.id)}
              disabled={adding}
            >
              {s.label}
            </button>
          ))}
        </div>
        {(createdCount > 0 || unknownCount > 0) && <p role="status">
          {createdCount} task(s) added in this batch. {unknownCount > 0 && `${unknownCount} outcome(s) remain unconfirmed. Check Planner before importing those tasks again.`} Confirmed and unconfirmed tasks are excluded from retry.
        </p>}

        {eligibleRepos.length === 0 ? (
          <p className="planner-import-empty">
            No {provider === 'github' ? 'GitHub' : 'Azure DevOps'} repositories
            are added yet. Add one from the workspace to import from it.
          </p>
        ) : (
          <label className="planner-import-repo">
            <RepoIcon size={14} />
            <select
              aria-label="Repository"
              value={repoId ?? ''}
              onChange={(e) => setRepoId(e.target.value)}
              disabled={adding}
            >
              {eligibleRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {eligibleRepos.length > 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(queryDraft.trim());
              if (source === 'ado-work-items') {
                const nextFilter = {
                  ...workItemDraft,
                  state: workItemDraft.state.trim(),
                  area: workItemDraft.area.trim(),
                  iteration: workItemDraft.iteration.trim(),
                  tag: workItemDraft.tag.trim(),
                };
                setWorkItemDraft(nextFilter);
                if (JSON.stringify(nextFilter) !== JSON.stringify(workItemFilter)) {
                  setWorkItemFilter(nextFilter);
                }
              }
            }}
          >
          <fieldset className="planner-import-filters" disabled={adding}>
            <legend>Filters</legend>
            {source === 'ado-work-items' ? <>
            <div className="planner-import-filter-seg" role="group" aria-label="Assigned to">
              <button
                type="button"
                className={
                  workItemDraft.assignedTo === 'me'
                    ? 'planner-import-seg is-active'
                    : 'planner-import-seg'
                }
                aria-pressed={workItemDraft.assignedTo === 'me'}
                onClick={() =>
                  setWorkItemDraft((f) => ({ ...f, assignedTo: 'me' }))
                }
              >
                Assigned to me
              </button>
              <button
                type="button"
                className={
                  workItemDraft.assignedTo === 'all'
                    ? 'planner-import-seg is-active'
                    : 'planner-import-seg'
                }
                aria-pressed={workItemDraft.assignedTo === 'all'}
                onClick={() =>
                  setWorkItemDraft((f) => ({ ...f, assignedTo: 'all' }))
                }
              >
                Everyone
              </button>
            </div>
            <label className="planner-import-filter-field">State
            <input
              className="planner-import-filter-input"
              type="text"
              value={workItemDraft.state}
              placeholder="Any non-closed state"
              aria-label="State"
              onChange={(e) =>
                setWorkItemDraft((f) => ({ ...f, state: e.target.value }))
              }
            />
            </label>
            <label className="planner-import-filter-field">Area path (includes children)
            <input
              className="planner-import-filter-input"
              type="text"
              value={workItemDraft.area}
              placeholder="Area path"
              aria-label="Area path"
              onChange={(e) =>
                setWorkItemDraft((f) => ({ ...f, area: e.target.value }))
              }
            />
            </label>
            <label className="planner-import-filter-field">Iteration path (includes children)
            <input
              className="planner-import-filter-input"
              type="text"
              value={workItemDraft.iteration}
              placeholder="Iteration path"
              aria-label="Iteration path"
              onChange={(e) =>
                setWorkItemDraft((f) => ({ ...f, iteration: e.target.value }))
              }
            />
            </label>
            <label className="planner-import-filter-field">Tag
            <input
              className="planner-import-filter-input"
              type="text"
              value={workItemDraft.tag}
              placeholder="Tag"
              aria-label="Tag"
              onChange={(e) =>
                setWorkItemDraft((f) => ({ ...f, tag: e.target.value }))
              }
            />
            </label>
            </> : (
              <label className="planner-import-filter-field">
                {isPullSource ? 'Pull request scope' : 'Issue scope'}
                <select
                  className="planner-import-filter-input"
                  value={isPullSource ? pullScope : issueScope}
                  onChange={(event) => {
                    if (isPullSource) {
                      setPullScope(event.target.value as ImportPullScope);
                    } else {
                      setIssueScope(event.target.value as IssueFilter);
                    }
                  }}
                >
                  <option value="mine">{isPullSource ? 'My PRs' : 'My issues'}</option>
                  <option value="assigned">Assigned to me</option>
                  <option value="all">{isPullSource ? 'All PRs' : 'All issues'}</option>
                  {isPullSource && <option value="team">Team</option>}
                </select>
              </label>
            )}
            {isPullSource && pullScope === 'team' && <>
              <label className="planner-import-filter-field">Team members (shared with Open Pull Request)
                <input className="planner-import-filter-input" value={memberDraft}
                  placeholder="Author name or login"
                  onChange={(event) => setMemberDraft(event.target.value)} />
              </label>
              <button type="button" disabled={!memberDraft.trim()} onClick={() => {
                setRoster((current) => [...current, memberDraft]);
                setMemberDraft('');
              }}>Add teammate</button>
              <div className="planner-import-filter-help">
                {roster.length === 0 ? 'No saved team: showing all returned authors.' : roster.map((member) => (
                  <button key={member} type="button" aria-label={`Remove teammate ${member}`}
                    onClick={() => setRoster((current) => current.filter((name) => name !== member))}>
                    {member} ×
                  </button>
                ))}
              </div>
              <label className="planner-import-filter-field">Order by time in review
                <select className="planner-import-filter-input" value={order}
                  onChange={(event) => setOrder(event.target.value as ReviewAgeOrder)}>
                  <option value="longest">Longest in review</option>
                  <option value="newest">Newest first</option>
                </select>
              </label>
            </>}
            <label className="planner-import-filter-field">
              Search loaded {isPullSource ? 'pull requests' : source === 'gh-issues' ? 'issues' : 'work items'}
              <input className="planner-import-filter-input" type="search"
                value={queryDraft} placeholder="Number, title, author or other displayed details"
                onChange={(event) => setQueryDraft(event.target.value)} />
            </label>
            <div className="planner-import-filter-actions">
              <button type="submit">Apply filters</button>
              <button type="button" onClick={() => {
                setQuery('');
                setQueryDraft('');
                setSelected(new Set());
                if (source === 'ado-work-items') {
                  setWorkItemDraft(defaultWorkItemFilter);
                  setWorkItemFilter(defaultWorkItemFilter);
                } else if (isPullSource) {
                  setPullScope('all');
                  setOrder('longest');
                } else {
                  setIssueScope('all');
                }
              }}>Reset filters</button>
            </div>
            <p className="planner-import-filter-help">
              {source === 'ado-work-items'
                ? 'Assignment, state, area, iteration and tag are applied on Azure DevOps when you apply filters. Work items are project-wide, not repository-scoped.'
                : 'Scope is applied by the provider and updates immediately. Only open items are returned.'}
              {' '}{isPullSource ? 'Search and Team refine' : 'Search refines'} only the returned results, which the provider may limit; {isPullSource ? 'they do' : 'it does'} not search the entire {source === 'ado-work-items' ? 'project' : 'repository'}.
              {' '}{rows.length} shown / {loadedRows.length} loaded.
            </p>
          </fieldset>
          </form>
        ) : null}

        <ErrorText error={error} />

        <div className="planner-import-list">
          {loading ? (
            <p className="planner-import-empty">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="planner-import-empty">
              {!repoId
                ? 'Pick a repository.'
                : loadedRows.length > 0
                  ? 'No loaded items match these filters.'
                  : 'No items returned. Try changing the filters.'}
            </p>
          ) : (
            <>
              <label className="planner-import-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={adding}
                  aria-label="Select all"
                />
                Select all ({rows.length})
              </label>
              <ul>
                {rows.map((row) => (
                  <li key={row.key}>
                    <label className="planner-import-item">
                      <input
                        type="checkbox"
                        checked={selected.has(row.key)}
                        onChange={() => toggle(row.key)}
                        disabled={adding}
                      />
                      <span className="planner-import-item-body">
                        <span className="planner-import-item-title">
                          {row.title}
                        </span>
                        <span className="planner-import-item-meta">
                          {row.meta}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="planner-import-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void addSelected()}
            disabled={adding || loading || selected.size === 0}
          >
            {adding
              ? 'Adding…'
              : `Add ${selected.size || ''} to Planner`.replace('  ', ' ')}
          </button>
        </div>
      </div>
    </div>
  );
}
