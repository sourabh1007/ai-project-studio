import { describe, it, expect } from 'vitest';
import type { GhRunner } from '../github-auth/github-auth-service.js';
import {
  parseGithubPulls,
  parseGithubPull,
  listGithubPulls,
  getGithubPull,
} from './github-pr-lister.js';

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
    number: 12,
    title: 'Add login',
    url: 'https://github.com/acme/app/pull/12',
    headRefName: 'feature/login',
    author: { login: 'octocat', name: 'Mona' },
  },
  {
    number: 8,
    title: 'Fix bug',
    url: 'https://github.com/acme/app/pull/8',
    headRefName: 'fix/bug',
    author: { login: 'hubot' },
  },
]);

describe('parseGithubPulls', () => {
  it('maps valid pull requests, preferring author name over login', () => {
    const pulls = parseGithubPulls(listJson);
    expect(pulls).toEqual([
      {
        provider: 'github',
        number: 12,
        title: 'Add login',
        url: 'https://github.com/acme/app/pull/12',
        sourceBranch: 'feature/login',
        author: 'Mona',
        isAuthor: false,
        isReviewer: false,
      },
      {
        provider: 'github',
        number: 8,
        title: 'Fix bug',
        url: 'https://github.com/acme/app/pull/8',
        sourceBranch: 'fix/bug',
        author: 'hubot',
        isAuthor: false,
        isReviewer: false,
      },
    ]);
  });

  it('flags the current user as author or requested reviewer', () => {
    const json = JSON.stringify([
      {
        number: 1,
        title: 'Mine',
        url: 'u1',
        headRefName: 'a',
        author: { login: 'Octocat' },
      },
      {
        number: 2,
        title: 'Review me',
        url: 'u2',
        headRefName: 'b',
        author: { login: 'someone' },
        reviewRequests: [{ slug: 'a-team' }, { login: 'octocat' }],
      },
      {
        number: 3,
        title: 'No author',
        url: 'u3',
        headRefName: 'c',
        author: null,
        reviewRequests: [{ login: 'octocat' }],
      },
    ]);
    const pulls = parseGithubPulls(json, 'octocat');
    expect(pulls[0]).toMatchObject({ isAuthor: true, isReviewer: false });
    expect(pulls[1]).toMatchObject({ isAuthor: false, isReviewer: true });
    expect(pulls[2]).toMatchObject({ isAuthor: false, isReviewer: true });
  });

  it('returns an empty array for invalid JSON', () => {
    expect(parseGithubPulls('not json')).toEqual([]);
  });

  it('returns an empty array when the payload is not an array', () => {
    expect(parseGithubPulls('{}')).toEqual([]);
  });

  it('skips entries missing a number or head branch and defaults', () => {
    const pulls = parseGithubPulls(
      JSON.stringify([
        { number: 1, headRefName: 'a' },
        { number: 2 },
        { headRefName: 'c' },
      ]),
    );
    expect(pulls).toEqual([
      {
        provider: 'github',
        number: 1,
        title: 'PR #1',
        url: '',
        sourceBranch: 'a',
        author: null,
        isAuthor: false,
        isReviewer: false,
      },
    ]);
  });
});

describe('parseGithubPull', () => {
  it('maps a single pull request object', () => {
    const pull = parseGithubPull(
      JSON.stringify({
        number: 5,
        title: 'One',
        url: 'u',
        headRefName: 'b',
        author: null,
      }),
    );
    expect(pull).toMatchObject({ number: 5, sourceBranch: 'b', author: null });
  });

  it('returns null for invalid JSON', () => {
    expect(parseGithubPull('nope')).toBeNull();
  });

  it('returns null when the payload is not an object', () => {
    expect(parseGithubPull('42')).toBeNull();
    expect(parseGithubPull('null')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseGithubPull(JSON.stringify({ number: 5 }))).toBeNull();
  });
});

describe('listGithubPulls', () => {
  it('requests open PRs for the repo with the default limit', async () => {
    const calls: string[][] = [];
    const pulls = await listGithubPulls(
      runner({ code: 0, stdout: listJson, stderr: '' }, calls),
      'acme/app',
    );
    expect(pulls).toHaveLength(2);
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'acme/app',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,url,headRefName,author,reviewRequests',
    ]);
  });

  it('honours a custom limit', async () => {
    const calls: string[][] = [];
    await listGithubPulls(
      runner({ code: 0, stdout: '[]', stderr: '' }, calls),
      'acme/app',
      { limit: 5 },
    );
    expect(calls[0]).toContain('5');
  });

  it('scopes to the current user for the "mine" filter', async () => {
    const calls: string[][] = [];
    await listGithubPulls(
      runner({ code: 0, stdout: '[]', stderr: '' }, calls),
      'acme/app',
      { filter: 'mine' },
    );
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'acme/app',
      '--state',
      'open',
      '--author',
      '@me',
      '--limit',
      '100',
      '--json',
      'number,title,url,headRefName,author,reviewRequests',
    ]);
  });

  it('searches review-requested for the "assigned" filter', async () => {
    const calls: string[][] = [];
    await listGithubPulls(
      runner({ code: 0, stdout: '[]', stderr: '' }, calls),
      'acme/app',
      { filter: 'assigned' },
    );
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'acme/app',
      '--search',
      'is:open review-requested:@me',
      '--limit',
      '100',
      '--json',
      'number,title,url,headRefName,author,reviewRequests',
    ]);
  });

  it('throws the stderr message on failure', async () => {
    await expect(
      listGithubPulls(runner({ code: 1, stdout: '', stderr: 'boom' }), 'a/b'),
    ).rejects.toThrow('boom');
  });

  it('throws a default message when stderr is empty', async () => {
    await expect(
      listGithubPulls(runner({ code: 1, stdout: '', stderr: '' }), 'a/b'),
    ).rejects.toThrow('Failed to list pull requests');
  });
});

describe('getGithubPull', () => {
  it('fetches a single PR by number', async () => {
    const calls: string[][] = [];
    const pull = await getGithubPull(
      runner(
        {
          code: 0,
          stdout: JSON.stringify({ number: 3, headRefName: 'x' }),
          stderr: '',
        },
        calls,
      ),
      'acme/app',
      3,
    );
    expect(pull?.number).toBe(3);
    expect(calls[0]).toEqual([
      'pr',
      'view',
      '3',
      '--repo',
      'acme/app',
      '--json',
      'number,title,url,headRefName,author,reviewRequests,body',
    ]);
  });

  it('keeps a non-empty body and nulls a whitespace-only body', async () => {
    const withBody = await getGithubPull(
      runner({
        code: 0,
        stdout: JSON.stringify({ number: 4, headRefName: 'x', body: 'Fixes the bug' }),
        stderr: '',
      }),
      'acme/app',
      4,
    );
    expect(withBody?.body).toBe('Fixes the bug');

    const blankBody = await getGithubPull(
      runner({
        code: 0,
        stdout: JSON.stringify({ number: 5, headRefName: 'x', body: '   ' }),
        stderr: '',
      }),
      'acme/app',
      5,
    );
    expect(blankBody?.body).toBeNull();
  });

  it('returns null when the command fails', async () => {
    const pull = await getGithubPull(
      runner({ code: 1, stdout: '', stderr: 'no pr' }),
      'acme/app',
      99,
    );
    expect(pull).toBeNull();
  });
});
