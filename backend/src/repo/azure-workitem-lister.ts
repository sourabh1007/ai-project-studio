import type {
  AzureHttpGetter,
  AzureHttpPoster,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import type { AzureRepoTarget } from './azure-pr-lister.js';
import type { RemoteWorkItem } from './remote-import-contract.js';

const API_VERSION = '7.1';

/** States that mean a work item is finished and should be hidden from import. */
const CLOSED_STATES = [
  'Closed',
  'Done',
  'Removed',
  'Resolved',
  'Completed',
];

/** Narrowing options for a work-item import, mirroring the board's own facets. */
export interface WorkItemFilter {
  /** `me` (default) scopes to the signed-in user; `all` to the whole project. */
  assignedTo?: 'me' | 'all';
  /** Exact workflow state (e.g. `Active`); omitted means "any non-closed". */
  state?: string;
  /** Area path; matched hierarchically with `UNDER`. */
  area?: string;
  /** Iteration path; matched hierarchically with `UNDER`. */
  iteration?: string;
  /** A single tag the item must carry. */
  tag?: string;
}

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * WIQL selecting a project's work items, narrowed by the given {@link
 * WorkItemFilter} and ordered newest-first. Defaults scope to the signed-in
 * user's still-active items, which keeps the result under Azure DevOps' 20k WIQL
 * cap (an unscoped "everything active" query 400s `VS402337` on large projects)
 * and matches the personal-planner use case of importing *your* work.
 */
export function activeWorkItemsWiql(
  project: string,
  filter: WorkItemFilter = {},
): string {
  const clauses = [`[System.TeamProject] = '${escapeWiql(project)}'`];
  const state = filter.state?.trim();
  if (state) {
    clauses.push(`[System.State] = '${escapeWiql(state)}'`);
  } else {
    const states = CLOSED_STATES.map((s) => `'${s}'`).join(', ');
    clauses.push(`[System.State] NOT IN (${states})`);
  }
  if ((filter.assignedTo ?? 'me') === 'me') {
    clauses.push('[System.AssignedTo] = @Me');
  }
  const area = filter.area?.trim();
  if (area) {
    clauses.push(`[System.AreaPath] UNDER '${escapeWiql(area)}'`);
  }
  const iteration = filter.iteration?.trim();
  if (iteration) {
    clauses.push(`[System.IterationPath] UNDER '${escapeWiql(iteration)}'`);
  }
  const tag = filter.tag?.trim();
  if (tag) {
    clauses.push(`[System.Tags] CONTAINS '${escapeWiql(tag)}'`);
  }
  return (
    `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ` +
    `ORDER BY [System.ChangedDate] DESC`
  );
}

/** REST URL that runs a WIQL query scoped to the target project. */
export function wiqlUrl(target: AzureRepoTarget): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/wit/wiql` +
    `?api-version=${API_VERSION}`
  );
}

/** REST URL fetching a batch of work items by id with the fields we display. */
export function workItemsUrl(org: string, ids: readonly number[]): string {
  const fields = [
    'System.Id',
    'System.Title',
    'System.WorkItemType',
    'System.State',
    'System.AssignedTo',
    'System.Description',
  ].join(',');
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems` +
    `?ids=${ids.join(',')}&fields=${encodeURIComponent(fields)}` +
    `&api-version=${API_VERSION}`
  );
}

/** Web URL that opens a work item in the Azure DevOps board. */
export function workItemWebUrl(target: AzureRepoTarget, id: number): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_workitems/edit/${id}`
  );
}

/** REST URL fetching a work item's discussion comments. */
export function workItemCommentsUrl(
  target: AzureRepoTarget,
  id: number,
): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/wit/workItems/${id}/comments` +
    '?api-version=7.1-preview.4'
  );
}

interface AdoWiqlResult {
  workItems?: { id?: number }[] | null;
}

interface AdoWorkItem {
  id?: number;
  fields?: Record<string, unknown> | null;
}

/** Extracts the work-item ids a WIQL query returned, in order. */
export function parseWiqlIds(body: unknown): number[] {
  const result = body as AdoWiqlResult | null;
  const items = result?.workItems;
  if (!Array.isArray(items)) {
    return [];
  }
  const ids: number[] = [];
  for (const item of items) {
    if (item && typeof item.id === 'number') {
      ids.push(item.id);
    }
  }
  return ids;
}

function stringField(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Reads an Azure identity field, which is an object with a display name. */
function assignedToName(fields: Record<string, unknown>): string | null {
  const value = fields['System.AssignedTo'];
  if (value && typeof value === 'object') {
    const name = (value as { displayName?: unknown }).displayName;
    if (typeof name === 'string' && name.trim()) {
      return name;
    }
  }
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Converts Azure DevOps HTML fields to compact plain text. */
export function htmlToText(html: string | null | undefined): string | null {
  if (typeof html !== 'string') {
    return null;
  }
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

function mapWorkItem(
  target: AzureRepoTarget,
  item: AdoWorkItem,
): RemoteWorkItem | null {
  const id = item?.id;
  const fields = item?.fields;
  if (typeof id !== 'number' || !fields || typeof fields !== 'object') {
    return null;
  }
  return {
    provider: 'azure-devops',
    id,
    title: stringField(fields, 'System.Title') ?? `Work item ${id}`,
    url: workItemWebUrl(target, id),
    type: stringField(fields, 'System.WorkItemType') ?? 'Work Item',
    state: stringField(fields, 'System.State') ?? '',
    assignedTo: assignedToName(fields),
    description: htmlToText(stringField(fields, 'System.Description')),
  };
}

/** Parses a `workitems` batch response into display work items, in order. */
export function parseWorkItems(
  target: AzureRepoTarget,
  body: unknown,
): RemoteWorkItem[] {
  const value =
    body && typeof body === 'object' && Array.isArray((body as { value?: unknown }).value)
      ? ((body as { value: AdoWorkItem[] }).value)
      : [];
  const items: RemoteWorkItem[] = [];
  for (const raw of value) {
    const mapped = mapWorkItem(target, raw);
    if (mapped) {
      items.push(mapped);
    }
  }
  return items;
}

/** Extracts Azure DevOps' human-readable error message from a failure body. */
export function adoErrorDetail(body: unknown): string {
  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return `: ${message.trim()}`;
    }
  }
  return '';
}

interface AdoCommentsResult {
  comments?: { text?: unknown }[] | null;
}

/** Parses an Azure DevOps comments response into plain text comments. */
export function parseWorkItemComments(body: unknown): string[] {
  const comments = (body as AdoCommentsResult | null)?.comments;
  if (!Array.isArray(comments)) {
    return [];
  }
  const parsed: string[] = [];
  for (const comment of comments) {
    const text = htmlToText(
      comment && typeof comment.text === 'string' ? comment.text : null,
    );
    if (text) {
      parsed.push(text);
    }
  }
  return parsed;
}

export interface AzureWorkItemDeps {
  token: AzureTokenGetter;
  httpGet: AzureHttpGetter;
  httpPost: AzureHttpPoster;
}

/**
 * Lists the active work items of an Azure DevOps project: runs a WIQL query for
 * every non-closed item (newest first), then batch-fetches the display fields
 * of the first `limit` ids. Uses the same cached OAuth token as PR listing.
 */
export async function listAzureWorkItems(
  deps: AzureWorkItemDeps,
  target: AzureRepoTarget,
  opts: { limit?: number; filter?: WorkItemFilter } = {},
): Promise<RemoteWorkItem[]> {
  const limit = opts.limit ?? 200;
  const token = await deps.token(target.org);
  if (!token) {
    throw new Error(
      'Not signed in to Azure DevOps. Sign in first, then try again.',
    );
  }
  const queried = await deps.httpPost(wiqlUrl(target), token, {
    query: activeWorkItemsWiql(target.project, opts.filter),
  });
  if (queried.status !== 200) {
    throw new Error(
      `Failed to query Azure DevOps work items (HTTP ${queried.status})` +
        adoErrorDetail(queried.body),
    );
  }
  const ids = parseWiqlIds(queried.body).slice(0, limit);
  if (ids.length === 0) {
    return [];
  }
  const details = await deps.httpGet(workItemsUrl(target.org, ids), token);
  if (details.status !== 200) {
    throw new Error(
      `Failed to load Azure DevOps work items (HTTP ${details.status})`,
    );
  }
  return parseWorkItems(target, details.body);
}

/** Lists the plain-text comments for a single Azure DevOps work item. */
export async function listAzureWorkItemComments(
  deps: AzureWorkItemDeps,
  target: AzureRepoTarget,
  id: number,
): Promise<string[]> {
  const token = await deps.token(target.org);
  if (!token) {
    throw new Error(
      'Not signed in to Azure DevOps. Sign in first, then try again.',
    );
  }
  const res = await deps.httpGet(workItemCommentsUrl(target, id), token);
  if (res.status !== 200) {
    throw new Error(
      `Failed to load Azure DevOps work-item comments (HTTP ${res.status})`,
    );
  }
  return parseWorkItemComments(res.body);
}
