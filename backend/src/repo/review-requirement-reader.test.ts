import { describe, expect, it } from 'vitest';
import type { GhRunner } from '../github-auth/github-auth-service.js';
import { readAzureReviewRequirement, readGithubReviewRequirement } from './review-requirement-reader.js';

describe('repository-scoped review requirement readers', () => {
  const target = { org: 'acme', project: 'Widgets', repo: 'widgets' };
  it('reads an explicitly linked GitHub issue including closed issues, without listing unrelated issues', async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ number: 7, title: 'Bounds', body: 'Keys must be bounded.' }), stderr: '' };
    };
    expect(await readGithubReviewRequirement(run, 'acme/widgets', 7, 1000)).toEqual({
      source: 'https://github.com/acme/widgets/issues/7', content: 'Bounds\nKeys must be bounded.',
    });
    expect(calls).toEqual([['issue', 'view', '7', '--repo', 'acme/widgets', '--json', 'number,title,body']]);
    expect((await readGithubReviewRequirement(async () => ({ code: 0, stdout: '{"number":7,"body":" x "}', stderr: '' }),
      'acme/widgets', 7, 10)).content).toBe('x');
    expect((await readGithubReviewRequirement(async () => ({ code: 0, stdout: '{"number":7,"body":" "}', stderr: '' }),
      'acme/widgets', 7, 10)).content).toBe('');
  });
  it('rejects invalid IDs, failed/malformed/mismatched responses and oversized issue content', async () => {
    const run: GhRunner = async () => ({ code: 0, stdout: '{}', stderr: '' });
    await expect(readGithubReviewRequirement(run, 'a/b', -1, 100)).rejects.toThrow('Invalid');
    await expect(readGithubReviewRequirement(async () => ({ code: 1, stdout: '', stderr: 'secret' }), 'a/b', 7, 100)).rejects.toThrow('unavailable');
    for (const stdout of ['bad', 'null', '[]', '{}', '{"number":8,"body":"x"}', '{"number":7}', '{"number":7,"body":1}',
      JSON.stringify({ number: 7, body: 'x'.repeat(101) })]) {
      await expect(readGithubReviewRequirement(async () => ({ code: 0, stdout, stderr: '' }), 'a/b', 7, 100)).rejects.toThrow();
    }
    await expect(readGithubReviewRequirement(async () => ({ code: 0, stdout: 'x'.repeat(1001), stderr: '' }), 'a/b', 7, 100)).rejects.toThrow('budget');
  });
  it('reads the exact project work item with description and acceptance criteria and strips HTML', async () => {
    let url = '';
    const fields = { 'System.TeamProject': 'Widgets', 'System.Title': 'Bounds', 'System.Description': '<p>Keep old keys</p>',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>At most 128 characters</p>' };
    const deps = { token: async () => 'token', httpGet: async (value: string) => {
      url = value; return { status: 200, body: { id: 7, fields } };
    } };
    expect(await readAzureReviewRequirement(deps, target, 7, 1000)).toEqual({
      source: 'https://dev.azure.com/acme/Widgets/_workitems/edit/7',
      content: 'Bounds\nKeep old keys\nAt most 128 characters',
    });
    expect(url).toContain('/Widgets/_apis/wit/workitems/7?fields=');
    expect(decodeURIComponent(url)).toContain('Microsoft.VSTS.Common.AcceptanceCriteria');
    expect((await readAzureReviewRequirement({ ...deps, httpGet: async () => ({
      status: 200, body: { id: 7, fields: { 'System.TeamProject': 'widgets' } },
    }) }, target, 7, 1000)).content).toBe('');
    expect((await readAzureReviewRequirement({ ...deps, httpGet: async () => ({
      status: 200, body: { id: 7, fields: { 'System.TeamProject': 'widgets', 'Microsoft.VSTS.Common.AcceptanceCriteria': 'Rule' } },
    }) }, target, 7, 1000)).content).toBe('Rule');
  });
  it('fails closed on unavailable, cross-project and unverifiable work items', async () => {
    const deps = { token: async () => 'token', httpGet: async () => ({ status: 200, body: null as unknown }) };
    await expect(readAzureReviewRequirement(deps, target, 0, 100)).rejects.toThrow('Invalid');
    await expect(readAzureReviewRequirement({ ...deps, token: async () => null }, target, 7, 100)).rejects.toThrow('sign-in');
    for (const result of [{ status: 404, body: {} }, { status: 200, body: null }, { status: 200, body: 'bad' },
      { status: 200, body: { id: 8 } }, { status: 200, body: { id: 7 } },
      { status: 200, body: { id: 7, fields: {} } },
      { status: 200, body: { id: 7, fields: { 'System.TeamProject': 1 } } },
      { status: 200, body: { id: 7, fields: { 'System.TeamProject': 'Other' } } }]) {
      await expect(readAzureReviewRequirement({ ...deps, httpGet: async () => result }, target, 7, 100)).rejects.toThrow();
    }
    await expect(readAzureReviewRequirement({ ...deps, httpGet: async () => ({ status: 200, body: {
      id: 7, fields: { 'System.TeamProject': 'Widgets', 'System.Description': 'x'.repeat(101) },
    } }) }, target, 7, 100)).rejects.toThrow('budget');
  });
});
