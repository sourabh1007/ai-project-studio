import { describe, it, expect } from 'vitest';
import type { GhRunner } from '../github-auth/github-auth-service.js';
import { parseGithubIssues, listGithubIssues } from './github-issue-lister.js';

function runner(
  result: { code: number; stdout: string; stderr: string },
  calls: string[][] = [],
): GhRunner {
  return (args) => {
    calls.push(args);
    return Promise.resolve(result);
  };
}

const listJson = JSON.stringify([
  {
    number: 42,
    title: 'Crash on launch',
    url: 'https://github.com/acme/app/issues/42',
    state: 'open',
    createdAt: '2024-01-01T00:00:00Z',
    author: { login: 'octocat' },
    assignees: [{ login: 'hubot' }, { login: '' }, {}],
    labels: [{ name: 'bug' }, { name: '' }, {}],
  },
  {
    number: 7,
    title: 'Docs typo',
    url: 'https://github.com/acme/app/issues/7',
  },
]);

describe('parseGithubIssues', () => {
  it('maps issues, filtering empty assignees and labels', () => {
    const issues = parseGithubIssues(listJson);
    expect(issues).toEqual([
      {
        provider: 'github',
        number: 42,
        title: 'Crash on launch',
        url: 'https://github.com/acme/app/issues/42',
        state: 'open',
        author: 'octocat',
        assignees: ['hubot'],
        labels: ['bug'],
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        provider: 'github',
        number: 7,
        title: 'Docs typo',
        url: 'https://github.com/acme/app/issues/7',
        state: 'open',
        author: null,
        assignees: [],
        labels: [],
        createdAt: null,
      },
    ]);
  });

  it('defaults a missing title and url', () => {
    const issues = parseGithubIssues(JSON.stringify([{ number: 3 }]));
    expect(issues[0]).toMatchObject({ title: 'Issue #3', url: '' });
  });

  it('returns an empty array for invalid JSON', () => {
    expect(parseGithubIssues('not json')).toEqual([]);
  });

  it('returns an empty array when the payload is not an array', () => {
    expect(parseGithubIssues('{}')).toEqual([]);
  });

  it('skips entries missing a number', () => {
    const issues = parseGithubIssues(
      JSON.stringify([{ title: 'No number' }, { number: 9 }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(9);
  });
});

describe('listGithubIssues', () => {
  it('requests open issues for the repo with the default limit', async () => {
    const calls: string[][] = [];
    const issues = await listGithubIssues(
      runner({ code: 0, stdout: listJson, stderr: '' }, calls),
      'acme/app',
    );
    expect(issues).toHaveLength(2);
    expect(calls[0]).toEqual([
      'issue',
      'list',
      '--repo',
      'acme/app',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,url,state,createdAt,author,assignees,labels',
    ]);
  });

  it('honours a custom limit', async () => {
    const calls: string[][] = [];
    await listGithubIssues(
      runner({ code: 0, stdout: '[]', stderr: '' }, calls),
      'acme/app',
      { limit: 5 },
    );
    expect(calls[0]).toContain('5');
  });

  it('scopes to the author for the "mine" filter', async () => {
    const calls: string[][] = [];
    await listGithubIssues(
      runner({ code: 0, stdout: '[]', stderr: '' }, calls),
      'acme/app',
      { filter: 'mine' },
    );
    expect(calls[0]).toContain('--author');
    expect(calls[0]).toContain('@me');
  });

  it('scopes to the assignee for the "assigned" filter', async () => {
    const calls: string[][] = [];
    await listGithubIssues(
      runner({ code: 0, stdout: '[]', stderr: '' }, calls),
      'acme/app',
      { filter: 'assigned' },
    );
    expect(calls[0]).toContain('--assignee');
    expect(calls[0]).toContain('@me');
  });

  it('throws the stderr message on failure', async () => {
    await expect(
      listGithubIssues(runner({ code: 1, stdout: '', stderr: 'boom' }), 'a/b'),
    ).rejects.toThrow('boom');
  });

  it('throws a default message when stderr is empty', async () => {
    await expect(
      listGithubIssues(runner({ code: 1, stdout: '', stderr: '' }), 'a/b'),
    ).rejects.toThrow('Failed to list issues');
  });
});
