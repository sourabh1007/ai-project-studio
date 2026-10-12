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

/** WIQL selecting every still-active work item in a project, newest first. */
export function activeWorkItemsWiql(project: string): string {
  const states = CLOSED_STATES.map((s) => `'${s}'`).join(', ');
  return (
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' ` +
    `AND [System.State] NOT IN (${states}) ` +
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
  opts: { limit?: number } = {},
): Promise<RemoteWorkItem[]> {
  const limit = opts.limit ?? 200;
  const token = await deps.token(target.org);
  if (!token) {
    throw new Error(
      'Not signed in to Azure DevOps. Sign in first, then try again.',
    );
  }
  const queried = await deps.httpPost(wiqlUrl(target), token, {
    query: activeWorkItemsWiql(target.project),
  });
  if (queried.status !== 200) {
    throw new Error(
      `Failed to query Azure DevOps work items (HTTP ${queried.status})`,
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
