import type { GhRunner } from '../github-auth/github-auth-service.js';
import type { AzureRepoTarget } from './azure-pr-lister.js';
import type { AzureWorkItemDeps } from './azure-workitem-lister.js';
import { htmlToText } from './azure-workitem-lister.js';

export interface LinkedReviewRequirement {
  source: string;
  content: string;
}

function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid linked requirement ID.');
}

function bounded(content: string, maxChars: number): string {
  if (content.length > maxChars) throw new Error('Linked requirement exceeds the review source budget.');
  return content;
}

export async function readGithubReviewRequirement(
  run: GhRunner, repo: string, id: number, maxChars: number,
): Promise<LinkedReviewRequirement> {
  assertId(id);
  const result = await run(['issue', 'view', String(id), '--repo', repo, '--json', 'number,title,body']);
  if (result.code !== 0) throw new Error('Linked issue is unavailable with the current repository credentials.');
  const item: unknown = JSON.parse(bounded(result.stdout, maxChars * 10));
  if (!item || typeof item !== 'object' || !('number' in item) || item.number !== id ||
      !('body' in item) || typeof item.body !== 'string') throw new Error('Linked issue returned unverifiable content.');
  const title = 'title' in item && typeof item.title === 'string' ? item.title : '';
  return {
    source: `https://github.com/${repo}/issues/${id}`,
    content: item.body.trim() ? bounded(`${title}\n${item.body}`.trim(), maxChars) : '',
  };
}

export async function readAzureReviewRequirement(
  deps: Pick<AzureWorkItemDeps, 'token' | 'httpGet'>, target: AzureRepoTarget, id: number, maxChars: number,
): Promise<LinkedReviewRequirement> {
  assertId(id);
  const token = await deps.token(target.org);
  if (!token) throw new Error('Linked work item requires Azure DevOps sign-in.');
  const projectUrl = `https://dev.azure.com/${encodeURIComponent(target.org)}/${encodeURIComponent(target.project)}`;
  const fields = ['System.Id', 'System.TeamProject', 'System.Title', 'System.Description',
    'Microsoft.VSTS.Common.AcceptanceCriteria'].join(',');
  const result = await deps.httpGet(`${projectUrl}/_apis/wit/workitems/${id}?fields=${encodeURIComponent(fields)}&api-version=7.1`, token);
  if (result.status !== 200 || !result.body || typeof result.body !== 'object') throw new Error('Linked work item is unavailable.');
  const item = result.body as { id?: unknown; fields?: Record<string, unknown> };
  if (item.id !== id || !item.fields ||
      typeof item.fields['System.TeamProject'] !== 'string' ||
      item.fields['System.TeamProject'].toLowerCase() !== target.project.toLowerCase()) {
    throw new Error('Linked work item is outside the selected project or cannot be verified.');
  }
  const text = (key: string) => htmlToText(typeof item.fields![key] === 'string' ? item.fields![key] : null);
  const description = text('System.Description');
  const criteria = text('Microsoft.VSTS.Common.AcceptanceCriteria');
  return {
    source: `${projectUrl}/_workitems/edit/${id}`,
    content: description || criteria
      ? bounded([text('System.Title'), description, criteria].filter(Boolean).join('\n'), maxChars) : '',
  };
}
