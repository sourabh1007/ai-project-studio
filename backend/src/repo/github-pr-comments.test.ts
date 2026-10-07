import { describe, expect, it } from 'vitest';
import type { GhCommandResult } from '../github-auth/github-auth-service.js';
import {
  addPrCommentArgs,
  addThreadArgs,
  createGithubCommentsGateway,
  listThreadsArgs,
  mapReactionGroups,
  parseAddedComment,
  parseAddedThread,
  parsePullNodeId,
  parsePullHeadSha,
  parseReactedComment,
  parseStatusResult,
  parseThreads,
  pullNodeIdArgs,
  reactArgs,
  setStatusArgs,
  splitSlug,
} from './github-pr-comments.js';

const TARGET = { repo: 'acme/widgets', number: 7 };

describe('guarded GitHub comment posts', () => {
  const input = { path: 'src/exact.cs', line: 42, body: ' edited\ncomment ', expectedHeadSha: 'captured' };
  const pull = (headRefOid: unknown) => JSON.stringify({
    data: { repository: { pullRequest: { id: 'PR1', headRefOid } } },
  });

  it.each(['not json', 'null', '{}', '{"data":{}}', '{"data":{"repository":{}}}',
    '{"data":{"repository":{"pullRequest":{}}}}', pull(null), pull(42), pull(''), pull('  ')])(
    'treats an unavailable head as unknown: %s', (stdout) => {
      expect(parsePullHeadSha(stdout)).toBeNull();
    },
  );

  it('preflights the live head in the existing node query and preserves exact RIGHT payload', async () => {
    const { run, calls } = queuedRunner([
      ok(pull('captured')),
      ok(JSON.stringify({ data: { addPullRequestReviewThread: {
        thread: { id: 'T1', path: input.path, line: input.line },
      } } })),
    ]);
    const result = await createGithubCommentsGateway(run, TARGET).add(input);
    expect(result.path).toBe(input.path);
    expect(result.line).toBe(input.line);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(
      'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid}}}',
    );
    expect(calls[1]).toContain('path=src/exact.cs');
    expect(calls[1]).toContain('line=42');
    expect(calls[1]).toContain('body= edited\ncomment ');
    expect(calls[1].join(' ')).toContain('side:RIGHT');
    expect(calls[1].join(' ')).not.toContain('expectedHeadSha');
  });

  it.each([undefined, null, '', 'moved'])('blocks missing or stale live head %j without posting', async (head) => {
    const { run, calls } = queuedRunner([ok(pull(head))]);
    await expect(createGithubCommentsGateway(run, TARGET).add(input)).rejects.toThrow(/live GitHub PR head/);
    expect(calls).toHaveLength(1);
  });

  it.each([null, 42, '', '  '])('rejects invalid expected head %j before provider IO', async (head) => {
    const { run, calls } = queuedRunner([]);
    await expect(createGithubCommentsGateway(run, TARGET).add({
      ...input, expectedHeadSha: head as string,
    })).rejects.toThrow(/expectedHeadSha/);
    expect(calls).toEqual([]);
  });

  it('propagates failed preflight without posting', async () => {
    const { run, calls } = queuedRunner([fail('head query failed')]);
    await expect(createGithubCommentsGateway(run, TARGET).add(input)).rejects.toThrow('head query failed');
    expect(calls).toHaveLength(1);
  });

  it('does not retry a failed guarded mutation', async () => {
    const { run, calls } = queuedRunner([ok(pull('captured')), fail('post failed')]);
    await expect(createGithubCommentsGateway(run, TARGET).add(input)).rejects.toThrow('post failed');
    expect(calls).toHaveLength(2);
  });

  it('keeps legacy node queries head-independent', () => {
    expect(pullNodeIdArgs(TARGET).join(' ')).not.toContain('headRefOid');
  });
});

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

  it('builds PR-level comment args without an anchor', () => {
    const args = addPrCommentArgs('PR1', { body: 'general note' });
    expect(args.join(' ')).toContain('addComment');
    expect(args).toContain('subjectId=PR1');
    expect(args).toContain('body=general note');
    expect(args.join(' ')).not.toContain('path=');
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
          authorAvatarUrl: 'https://github.com/alice.png',
          body: 'nit',
          createdAt: '2026-01-01T00:00:00Z',
          reactions: [],
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
    expect(t.comments[0].authorAvatarUrl).toBeNull();
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

describe('parseAddedComment', () => {
  it('maps a PR-level comment as an unanchored thread', () => {
    const json = JSON.stringify({
      data: {
        addComment: {
          commentEdge: { node: { id: 'IC9', body: 'general note', author: { login: 'octo' } } },
        },
      },
    });
    const thread = parseAddedComment(json);
    expect(thread?.id).toBe('IC9');
    expect(thread?.path).toBeNull();
    expect(thread?.line).toBeNull();
    expect(thread?.status).toBe('active');
    expect(thread?.comments[0].body).toBe('general note');
  });

  it.each([
    'nope',
    JSON.stringify({ data: {} }),
    JSON.stringify({ data: { addComment: { commentEdge: {} } } }),
    JSON.stringify({ data: { addComment: { commentEdge: { node: { body: 'x' } } } } }),
  ])('returns null for %s', (stdout) => {
    expect(parseAddedComment(stdout)).toBeNull();
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

  it('posts a PR-level comment when no anchor is supplied', async () => {
    const pullId = JSON.stringify({
      data: { repository: { pullRequest: { id: 'PR1' } } },
    });
    const created = JSON.stringify({
      data: { addComment: { commentEdge: { node: { id: 'IC1', body: 'general note' } } } },
    });
    const { run, calls } = queuedRunner([ok(pullId), ok(created)]);
    const gw = createGithubCommentsGateway(run, TARGET);
    const thread = await gw.add({ body: 'general note' });
    expect(thread.id).toBe('IC1');
    expect(thread.path).toBeNull();
    expect(calls[1].join(' ')).toContain('addComment');
    expect(calls[1]).toContain('subjectId=PR1');
  });

  it('throws when GitHub returns no created PR-level comment', async () => {
    const pullId = JSON.stringify({
      data: { repository: { pullRequest: { id: 'PR1' } } },
    });
    const { run } = queuedRunner([ok(pullId), ok(JSON.stringify({ data: {} }))]);
    const gw = createGithubCommentsGateway(run, TARGET);
    await expect(gw.add({ body: 'general note' })).rejects.toThrow(/did not return/);
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

  it('reacts to a comment and returns the updated reactions', async () => {
    const json = JSON.stringify({
      data: {
        addReaction: {
          subject: {
            reactionGroups: [
              { content: 'THUMBS_UP', viewerHasReacted: true, reactors: { totalCount: 3 } },
            ],
          },
        },
      },
    });
    const { run, calls } = queuedRunner([ok(json)]);
    const gw = createGithubCommentsGateway(run, TARGET);
    const comment = await gw.react({ threadId: 'T1', commentId: 'C9', content: 'THUMBS_UP', on: true });
    expect(comment.id).toBe('C9');
    expect(comment.reactions).toEqual([
      { content: 'THUMBS_UP', count: 3, viewerReacted: true },
    ]);
    expect(calls[0].join(' ')).toContain('addReaction');
    expect(calls[0]).toContain('subjectId=C9');
    expect(calls[0]).toContain('content=THUMBS_UP');
  });
});

describe('reactArgs', () => {
  it('builds add-reaction args when toggling on', () => {
    const args = reactArgs({ threadId: 'T1', commentId: 'C1', content: 'HEART', on: true });
    expect(args.join(' ')).toContain('addReaction');
    expect(args).toContain('subjectId=C1');
    expect(args).toContain('content=HEART');
  });

  it('builds remove-reaction args when toggling off', () => {
    const args = reactArgs({ threadId: 'T1', commentId: 'C1', content: 'HEART', on: false });
    expect(args.join(' ')).toContain('removeReaction');
  });
});

describe('mapReactionGroups', () => {
  it('maps valid groups and uses the users fallback count', () => {
    expect(
      mapReactionGroups([
        { content: 'THUMBS_UP', viewerHasReacted: true, reactors: { totalCount: 2 } },
        { content: 'HEART', users: { totalCount: 4 } },
      ]),
    ).toEqual([
      { content: 'THUMBS_UP', count: 2, viewerReacted: true },
      { content: 'HEART', count: 4, viewerReacted: false },
    ]);
  });

  it('drops empty, unknown, and malformed groups', () => {
    expect(
      mapReactionGroups([
        { content: 'THUMBS_UP', reactors: { totalCount: 0 } },
        { content: 'EYES' },
        { content: 'UNKNOWN', reactors: { totalCount: 5 } },
        { reactors: { totalCount: 5 } },
        {},
      ]),
    ).toEqual([]);
  });

  it('returns [] for null or undefined', () => {
    expect(mapReactionGroups(null)).toEqual([]);
    expect(mapReactionGroups(undefined)).toEqual([]);
  });
});

describe('parseReactedComment', () => {
  it('parses reaction groups across any mutation field name', () => {
    const json = JSON.stringify({
      data: {
        removeReaction: {
          subject: { reactionGroups: [{ content: 'ROCKET', reactors: { totalCount: 1 } }] },
        },
      },
    });
    expect(parseReactedComment(json, 'C1')).toEqual({
      id: 'C1',
      author: null,
      authorAvatarUrl: null,
      body: '',
      createdAt: null,
      reactions: [{ content: 'ROCKET', count: 1, viewerReacted: false }],
    });
  });

  it('leaves reactions empty for unparsable output', () => {
    expect(parseReactedComment('not json', 'C2').reactions).toEqual([]);
  });

  it('leaves reactions empty when no subject carries reaction groups', () => {
    expect(parseReactedComment(JSON.stringify({ data: { addReaction: {} } }), 'C3').reactions).toEqual([]);
  });

  it('leaves reactions empty when the response has no data field', () => {
    expect(parseReactedComment('{}', 'C4').reactions).toEqual([]);
  });
});

