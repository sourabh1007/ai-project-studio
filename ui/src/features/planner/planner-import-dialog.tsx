import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api.js';
import { ErrorText } from '../../components/ui.js';
import { CloseIcon, ImportIcon, RepoIcon } from '../../components/icons.js';
import {
  issueToTask,
  pullToTask,
  workItemToTask,
} from '../../lib/planner-import.js';
import type {
  CreatePlannerTaskInput,
  RepoProvider,
  Repository,
} from '../../lib/types.js';

/** The subset of the API client the import dialog depends on. */
export type PlannerImportApi = Pick<
  ApiClient,
  'listRepoWorkItems' | 'listRepoIssues' | 'listRepoPulls' | 'createPlannerTask'
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
}

interface PlannerImportDialogProps {
  api: PlannerImportApi;
  repos: Repository[];
  /** Day the imported tasks land on (`YYYY-MM-DD`). */
  date: string;
  onClose: () => void;
  /** Called with how many tasks were created once an import completes. */
  onImported: (count: number) => void;
}

/** Loads a source's items for a repo and normalizes them into import rows. */
async function loadRows(
  api: PlannerImportApi,
  source: ImportSource,
  repoId: string,
  date: string,
): Promise<ImportRow[]> {
  if (source === 'ado-work-items') {
    const items = await api.listRepoWorkItems(repoId);
    return items.map((item) => ({
      key: `wi-${item.id}`,
      title: item.title,
      meta: [item.type, item.state, item.assignedTo ?? 'Unassigned']
        .filter((p) => p)
        .join(' · '),
      task: workItemToTask(item, repoId, date),
    }));
  }
  if (source === 'gh-issues') {
    const items = await api.listRepoIssues(repoId);
    return items.map((item) => ({
      key: `issue-${item.number}`,
      title: item.title,
      meta: [`#${item.number}`, item.author ?? 'unknown', ...item.labels]
        .filter((p) => p)
        .join(' · '),
      task: issueToTask(item, repoId, date),
    }));
  }
  const pulls = await api.listRepoPulls(repoId);
  return pulls.map((pull) => ({
    key: `pr-${pull.number}`,
    title: pull.title,
    meta: [`#${pull.number}`, pull.author ?? 'unknown', pull.sourceBranch]
      .filter((p) => p)
      .join(' · '),
    task: pullToTask(pull, repoId, date),
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
}: PlannerImportDialogProps): JSX.Element {
  const [source, setSource] = useState<ImportSource>('ado-work-items');
  const provider = SOURCES.find((s) => s.id === source)!.provider;
  const eligibleRepos = useMemo(
    () => repos.filter((r) => r.provider === provider),
    [repos, provider],
  );
  const [repoId, setRepoId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Keep a valid repo selected for the active source's provider.
  useEffect(() => {
    setRepoId((current) => {
      if (current && eligibleRepos.some((r) => r.id === current)) {
        return current;
      }
      return eligibleRepos[0]?.id ?? null;
    });
  }, [eligibleRepos]);

  // Load the chosen source/repo's items whenever either changes.
  useEffect(() => {
    if (!repoId) {
      setRows([]);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    loadRows(api, source, repoId, date)
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
  }, [api, source, repoId, date]);

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
    try {
      for (const row of chosen) {
        await api.createPlannerTask(row.task);
      }
      onImported(chosen.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add tasks.');
    } finally {
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
        className="planner-summary-modal planner-import-modal"
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
            >
              {s.label}
            </button>
          ))}
        </div>

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
            >
              {eligibleRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <ErrorText error={error} />

        <div className="planner-import-list">
          {loading ? (
            <p className="planner-import-empty">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="planner-import-empty">
              {repoId ? 'Nothing to import from here.' : 'Pick a repository.'}
            </p>
          ) : (
            <>
              <label className="planner-import-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
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
            disabled={adding || selected.size === 0}
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
