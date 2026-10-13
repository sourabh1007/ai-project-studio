import type {
  CreatePlannerTaskInput,
  RemoteIssue,
  RemotePullRequest,
  RemoteWorkItem,
  WorkItemFilter,
} from './types';

/**
 * Pure mappers turning items imported from a repository's provider (Azure
 * DevOps work items / pull requests, GitHub issues / pull requests) into
 * `CreatePlannerTaskInput`s. Pull requests become launchable `pr` tasks; work
 * items and issues become plain `task`s that carry a link back to the source
 * item in their notes. All functions are deterministic and side-effect free.
 */

/** The kind of provider item an import row represents. */
export type ImportKind = 'work-item' | 'issue' | 'pull';

/** The default work-item import filter: the signed-in user's active items. */
export const defaultWorkItemFilter: WorkItemFilter = {
  assignedTo: 'me',
  state: '',
  area: '',
  iteration: '',
  tag: '',
};

/** Type guard for a persisted {@link WorkItemFilter} (rejects corrupt entries). */
export function isWorkItemFilter(value: unknown): value is WorkItemFilter {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const f = value as Record<string, unknown>;
  return (
    (f.assignedTo === 'me' || f.assignedTo === 'all') &&
    typeof f.state === 'string' &&
    typeof f.area === 'string' &&
    typeof f.iteration === 'string' &&
    typeof f.tag === 'string'
  );
}

/** Joins the non-empty note lines into a single notes string. */
function joinNotes(lines: (string | null | undefined)[]): string {
  return lines.filter((line): line is string => !!line && line.length > 0).join('\n');
}

/** Maps an Azure DevOps work item to a plain planner task linking back to it. */
export function workItemToTask(
  item: RemoteWorkItem,
  repoId: string | null,
  date?: string,
  comments: string[] = [],
): CreatePlannerTaskInput {
  return {
    title: item.title,
    kind: 'task',
    notes: joinNotes([
      `${item.type} #${item.id}${item.state ? ` · ${item.state}` : ''}`,
      item.assignedTo ? `Assigned to ${item.assignedTo}` : null,
      item.url,
      item.description ? `Description:\n${item.description}` : null,
      comments.length > 0 ? `Comments:\n${comments.join('\n')}` : null,
    ]),
    repoId,
    ...(date ? { date } : {}),
  };
}

/** Maps a GitHub issue to a plain planner task linking back to it. */
export function issueToTask(
  issue: RemoteIssue,
  repoId: string | null,
  date?: string,
): CreatePlannerTaskInput {
  return {
    title: issue.title,
    kind: 'task',
    notes: joinNotes([
      `Issue #${issue.number}${issue.state ? ` · ${issue.state}` : ''}`,
      issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : null,
      issue.url,
    ]),
    repoId,
    ...(date ? { date } : {}),
  };
}

/** Maps a pull request to a launchable `pr` planner task. */
export function pullToTask(
  pull: RemotePullRequest,
  repoId: string | null,
  date?: string,
): CreatePlannerTaskInput {
  return {
    title: pull.title,
    kind: 'pr',
    prUrl: pull.url,
    notes: joinNotes([
      `PR #${pull.number}`,
      pull.author ? `Author: ${pull.author}` : null,
      pull.body,
    ]),
    repoId,
    ...(date ? { date } : {}),
  };
}
