import { describe, expect, it } from 'vitest';
import type { GhCommandResult } from '../github-auth/github-auth-service.js';
import {
  addThreadArgs,
  createGithubCommentsGateway,
  listThreadsArgs,
  parseAddedThread,
  parsePullNodeId,
  parseStatusResult,
  parseThreads,
  pullNodeIdArgs,
  setStatusArgs,
  splitSlug,
} from './github-pr-comments.js';

const TARGET = { repo: 'acme/widgets', number: 7 };

function ok(stdout: string): GhCommandResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr: string): GhCommandResult {
  return { code: 1, stdout: '', stderr };
}

function queuedRunner(results: GhCommandResult[]): {
  run: (args: string[]) => Promise<GhCommandResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return results[i++] ?? ok('{}');
    },
  };
}

const THREADS_JSON = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              id: 'T1',
              isResolved: false,
              path: 'a.cs',
              line: 12,
              comments: {
                nodes: [
                  {
                    id: 'C1',
                    body: 'nit',
                    path: 'a.cs',
                    line: 12,
                    createdAt: '2026-01-01T00:00:00Z',
                    author: { login: 'alice' },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
});

describe('splitSlug', () => {
  it('splits owner/name', () => {
    expect(splitSlug('acme/widgets')).toEqual({
      owner: 'acme',
      name: 'widgets',
    });
  });

  it.each(['nowhere', '/widgets', 'acme/'])('rejects %s', (slug) => {
    expect(() => splitSlug(slug)).toThrow(/owner\/name/);
  });
});

describe('argument builders', () => {
  it('builds list args with owner/name/number', () => {
    const args = listThreadsArgs(TARGET);
    expect(args).toContain('graphql');
    expect(args).toContain('owner=acme');
    expect(args).toContain('name=widgets');
    expect(args).toContain('number=7');
  });

  it('builds resolve args for resolved status', () => {
    const args = setStatusArgs('T1', 'resolved');
    expect(args.join(' ')).toContain('resolveReviewThread');
    expect(args).toContain('threadId=T1');
  });

  it('builds unresolve args for active status', () => {
    const args = setStatusArgs('T1', 'active');
    expect(args.join(' ')).toContain('unresolveReviewThread');
  });

  it('builds add-thread args', () => {
    const args = addThreadArgs('PR1', { path: 'a.cs', line: 4, body: 'hi' });
    expect(args).toContain('pullRequestId=PR1');
    expect(args).toContain('path=a.cs');
    expect(args).toContain('line=4');
    expect(args).toContain('body=hi');
  });

  it('builds pull-node-id args', () => {
    expect(pullNodeIdArgs(TARGET)).toContain('owner=acme');
  });
});

describe('parseThreads', () => {
  it('maps threads and comments', () => {
    const [t] = parseThreads(THREADS_JSON);
    expect(t).toEqual({
      id: 'T1',
      path: 'a.cs',
      line: 12,
      status: 'active',
      comments: [
        {
          id: 'C1',
          author: 'alice',
          body: 'nit',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
  });

  it('falls back to the first comment path/line and marks resolved', () => {
    const json = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'T2',
                  isResolved: true,
                  comments: {
                    nodes: [{ id: 'C2', path: 'b.cs', line: 9 }],
                  },
                },
              ],
            },
          },
        },
      },
    });
    const [t] = parseThreads(json);
    expect(t.path).toBe('b.cs');
    expect(t.line).toBe(9);
    expect(t.status).toBe('resolved');
    expect(t.comments[0].body).toBe('');
    expect(t.comments[0].author).toBeNull();
    expect(t.comments[0].createdAt).toBeNull();
  });

  it('drops comments and threads without an id', () => {
    const json = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: false },
                {
                  id: 'T3',
                  comments: { nodes: [{ body: 'x' }, null] },
                },
              ],
            },
          },
        },
      },
    });
    const threads = parseThreads(json);
    expect(threads).toHaveLength(1);
    expect(threads[0].comments).toEqual([]);
    expect(threads[0].path).toBeNull();
    expect(threads[0].line).toBeNull();
  });

  it('returns [] for invalid json', () => {
    expect(parseThreads('not json')).toEqual([]);
  });

  it('returns [] when nodes is missing', () => {
    expect(parseThreads(JSON.stringify({ data: {} }))).toEqual([]);
  });

  it('treats a thread with no comments field as having none', () => {
    const json = JSON.stringify({
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [{ id: 'T9' }] } },
        },
      },
    });
    const [t] = parseThreads(json);
    expect(t.comments).toEqual([]);
  });
});

describe('parsePullNodeId', () => {
  it('reads the id', () => {
    const json = JSON.stringify({
      data: { repository: { pullRequest: { id: 'PR9' } } },
    });
    expect(parsePullNodeId(json)).toBe('PR9');
  });

  it('returns null when missing or empty', () => {
    expect(parsePullNodeId(JSON.stringify({ data: {} }))).toBeNull();
    expect(
      parsePullNodeId(
        JSON.stringify({ data: { repository: { pullRequest: { id: '' } } } }),
      ),
    ).toBeNull();
  });

  it('returns null for invalid json', () => {
    expect(parsePullNodeId('{')).toBeNull();
  });
});

describe('parseAddedThread', () => {
  it('maps the created thread', () => {
    const json = JSON.stringify({
      data: {
        addPullRequestReviewThread: {
          thread: {
            id: 'T5',
            isResolved: false,
            path: 'a.cs',
            line: 3,
            comments: { nodes: [{ id: 'C5', body: 'ok' }] },
          },
        },
      },
    });
    expect(parseAddedThread(json)?.id).toBe('T5');
  });

  it('returns null when no thread is present', () => {
    expect(parseAddedThread(JSON.stringify({ data: {} }))).toBeNull();
  });

  it('returns null for invalid json', () => {
    expect(parseAddedThread('nope')).toBeNull();
  });
});

describe('parseStatusResult', () => {
  it('reads isResolved from the mutation payload', () => {
    const json = JSON.stringify({
      data: { resolveReviewThread: { thread: { isResolved: true } } },
    });
    expect(parseStatusResult(json, 'T1', 'active').status).toBe('resolved');
  });

  it('ignores payload entries without a boolean isResolved', () => {
    const json = JSON.stringify({
      data: { unresolveReviewThread: { thread: {} } },
    });
    expect(parseStatusResult(json, 'T1', 'active').status).toBe('active');
  });

  it('falls back to the requested status for invalid json', () => {
    expect(parseStatusResult('{', 'T1', 'resolved').status).toBe('resolved');
  });

  it('falls back to the requested status when there is no data key', () => {
    expect(parseStatusResult('{}', 'T1', 'active').status).toBe('active');
  });
});

describe('createGithubCommentsGateway', () => {
  it('lists threads', async () => {
    const { run } = queuedRunner([ok(THREADS_JSON)]);
    const gw = createGithubCommentsGateway(run, TARGET);
    const threads = await gw.list();
    expect(threads[0].id).toBe('T1');
  });

  it('throws a ProviderError when gh exits non-zero', async () => {
    const { run } = queuedRunner([fail('boom')]);
    const gw = createGithubCommentsGateway(run, TARGET);
    await expect(gw.list()).rejects.toThrow(/boom/);
  });

  it('uses a default message when stderr is empty', async () => {
    const { run } = queuedRunner([fail('   ')]);
    const gw = createGithubCommentsGateway(run, TARGET);
    await expect(gw.list()).rejects.toThrow(/Failed to list comments/);
  });

  it('adds a comment by resolving the pull id then creating a thread', async () => {
    const pullId = JSON.stringify({
      data: { repository: { pullRequest: { id: 'PR1' } } },
    });
    const created = JSON.stringify({
      data: {
        addPullRequestReviewThread: {
          thread: { id: 'T7', comments: { nodes: [] } },
        },
      },
    });
    const { run, calls } = queuedRunner([ok(pullId), ok(created)]);
    const gw = createGithubCommentsGateway(run, TARGET);
    const thread = await gw.add({ path: 'a.cs', line: 2, body: 'hi' });
    expect(thread.id).toBe('T7');
    expect(calls[1]).toContain('pullRequestId=PR1');
  });

  it('throws when the pull id cannot be resolved', async () => {
    const { run } = queuedRunner([ok(JSON.stringify({ data: {} }))]);
    const gw = createGithubCommentsGateway(run, TARGET);
    await expect(
      gw.add({ path: 'a.cs', line: 2, body: 'hi' }),
    ).rejects.toThrow(/node id/);
  });

  it('throws when GitHub returns no created thread', async () => {
    const pullId = JSON.stringify({
      data: { repository: { pullRequest: { id: 'PR1' } } },
    });
    const { run } = queuedRunner([ok(pullId), ok(JSON.stringify({ data: {} }))]);
    const gw = createGithubCommentsGateway(run, TARGET);
    await expect(
      gw.add({ path: 'a.cs', line: 2, body: 'hi' }),
    ).rejects.toThrow(/did not return/);
  });

  it('sets status', async () => {
    const json = JSON.stringify({
      data: { resolveReviewThread: { thread: { isResolved: true } } },
    });
    const { run } = queuedRunner([ok(json)]);
    const gw = createGithubCommentsGateway(run, TARGET);
    const updated = await gw.setStatus('T1', 'resolved');
    expect(updated.status).toBe('resolved');
  });
});
