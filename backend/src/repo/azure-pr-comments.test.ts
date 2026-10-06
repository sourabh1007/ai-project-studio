import { describe, expect, it, vi } from 'vitest';
import type { AzureHttpResponse } from './azure-repo-lister.js';
import {
  azureStatusValue,
  buildAddThreadBody,
  createAzureCommentsGateway,
  mapAzureStatus,
  mapThread,
  parseThreads,
  threadUrl,
  threadsUrl,
  type AzureCommentsDeps,
  type AzurePrTarget,
} from './azure-pr-comments.js';

const TARGET: AzurePrTarget = {
  org: 'acme',
  project: 'Widgets',
  repo: 'core',
  pullRequestId: 42,
};

function resp(status: number, body: unknown = null): AzureHttpResponse {
  return { status, body };
}

function deps(overrides: Partial<AzureCommentsDeps> = {}): AzureCommentsDeps {
  return {
    token: async () => 'tok',
    httpGet: async () => resp(200, { value: [] }),
    httpPost: async () => resp(200, {}),
    httpPatch: async () => resp(200, {}),
    ...overrides,
  };
}

const THREAD = {
  id: 5,
  status: 'active',
  threadContext: { filePath: '/a.cs', rightFileStart: { line: 12 } },
  comments: [
    {
      id: 1,
      content: 'nit',
      publishedDate: '2026-01-01T00:00:00Z',
      author: { displayName: 'Alice', imageUrl: 'https://ado/alice.png' },
      commentType: 'text',
    },
  ],
};

describe('guarded Azure comment posts', () => {
  const input = { path: 'src/exact.cs', line: 42, body: ' edited\ncomment ', expectedHeadSha: 'captured' };

  it('checks the live source commit first and sends the exact right-side coordinates and edited body', async () => {
    const calls: string[] = [];
    const httpGet = vi.fn(async () => {
      calls.push('get');
      return resp(200, { lastMergeSourceCommit: { commitId: 'captured' } });
    });
    const httpPost = vi.fn(async () => { calls.push('post'); return resp(201, THREAD); });
    await createAzureCommentsGateway(deps({ httpGet, httpPost }), TARGET).add(input);
    expect(calls).toEqual(['get', 'post']);
    expect(httpGet).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/Widgets/_apis/git/repositories/core/pullRequests/42?api-version=7.1', 'tok',
    );
    expect(httpPost).toHaveBeenCalledWith(threadsUrl(TARGET), 'tok', {
      comments: [{ parentCommentId: 0, content: ' edited\ncomment ', commentType: 'text' }],
      status: 'active',
      threadContext: {
        filePath: '/src/exact.cs',
        rightFileStart: { line: 42, offset: 1 },
        rightFileEnd: { line: 42, offset: 1 },
      },
    });
  });

  it.each([null, {}, { lastMergeSourceCommit: {} },
    { lastMergeSourceCommit: null }, { lastMergeSourceCommit: { commitId: 'moved' } },
    { lastMergeSourceCommit: { commitId: 42 } }])('blocks stale or missing source head %j', async (body) => {
    const httpPost = vi.fn();
    const httpGet = vi.fn(async () => resp(200, body));
    await expect(createAzureCommentsGateway(deps({ httpGet, httpPost }), TARGET).add(input))
      .rejects.toThrow(/live Azure DevOps PR head/);
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it.each([null, 42, '', '  '])('rejects invalid expected head %j before provider IO', async (head) => {
    const token = vi.fn();
    const httpGet = vi.fn();
    const httpPost = vi.fn();
    await expect(createAzureCommentsGateway(deps({ token, httpGet, httpPost }), TARGET).add({
      ...input, expectedHeadSha: head as string,
    })).rejects.toThrow(/expectedHeadSha/);
    expect(token).not.toHaveBeenCalled();
    expect(httpGet).not.toHaveBeenCalled();
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('blocks on preflight HTTP failure and never retries', async () => {
    const httpGet = vi.fn(async () => resp(503));
    const httpPost = vi.fn();
    await expect(createAzureCommentsGateway(deps({ httpGet, httpPost }), TARGET).add(input))
      .rejects.toThrow(/verify.*HTTP 503/);
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('propagates transport and posting failures without retries', async () => {
    const httpGet = vi.fn(async () => { throw new Error('network'); });
    const httpPost = vi.fn(async () => resp(500));
    await expect(createAzureCommentsGateway(deps({ httpGet, httpPost }), TARGET).add(input))
      .rejects.toThrow('network');
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(httpPost).not.toHaveBeenCalled();
    const gateway = createAzureCommentsGateway(deps({
      httpGet: async () => resp(200, { lastMergeSourceCommit: { commitId: 'captured' } }), httpPost,
    }), TARGET);
    await expect(gateway.add(input)).rejects.toThrow(/HTTP 500/);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it('does not preflight legacy manual comments', async () => {
    const httpGet = vi.fn();
    const httpPost = vi.fn(async () => resp(201, THREAD));
    await createAzureCommentsGateway(deps({ httpGet, httpPost }), TARGET)
      .add({ path: 'a.cs', line: 12, body: 'legacy' });
    expect(httpGet).not.toHaveBeenCalled();
    expect(httpPost).toHaveBeenCalledTimes(1);
  });
});

describe('url builders', () => {
  it('builds the threads list url', () => {
    expect(threadsUrl(TARGET)).toContain(
      '/core/pullRequests/42/threads?api-version=7.1',
    );
  });

  it('builds a single thread url', () => {
    expect(threadUrl(TARGET, '9')).toContain('/threads/9?api-version=7.1');
  });
});

describe('status mapping', () => {
  it('maps active to active and everything else to resolved', () => {
    expect(mapAzureStatus('active')).toBe('active');
    expect(mapAzureStatus('fixed')).toBe('resolved');
    expect(mapAzureStatus(undefined)).toBe('resolved');
  });

  it('maps our status to azure values', () => {
    expect(azureStatusValue('resolved')).toBe('closed');
    expect(azureStatusValue('active')).toBe('active');
  });
});

describe('mapThread', () => {
  it('maps a thread with an anchored comment', () => {
    expect(mapThread(THREAD)).toEqual({
      id: '5',
      path: 'a.cs',
      line: 12,
      status: 'active',
      comments: [
        {
          id: '1',
          author: 'Alice',
          authorAvatarUrl: 'https://ado/alice.png',
          body: 'nit',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
  });

  it('falls back to uniqueName and null fields', () => {
    const t = mapThread({
      id: 6,
      status: 'fixed',
      comments: [{ id: 2, author: { uniqueName: 'a@b.com' } }],
    });
    expect(t?.comments[0].author).toBe('a@b.com');
    expect(t?.comments[0].authorAvatarUrl).toBeNull();
    expect(t?.comments[0].body).toBe('');
    expect(t?.comments[0].createdAt).toBeNull();
    expect(t?.path).toBeNull();
    expect(t?.line).toBeNull();
    expect(t?.status).toBe('resolved');
  });

  it('returns null for deleted, id-less, or comment-less threads', () => {
    expect(mapThread({ id: 7, isDeleted: true, comments: [{ id: 1 }] })).toBeNull();
    expect(mapThread({ status: 'active' })).toBeNull();
    expect(mapThread({ id: 8, comments: [] })).toBeNull();
    expect(mapThread({ id: 9, comments: [{ content: 'x' }] })).toBeNull();
    expect(mapThread({ id: 10 })).toBeNull();
  });

  it('keeps a relative file path and null author when both names are absent', () => {
    const t = mapThread({
      id: 11,
      status: 'active',
      threadContext: { filePath: 'nested/a.cs', rightFileStart: { line: 2 } },
      comments: [{ id: 3, content: 'x', author: {} }],
    });
    expect(t?.path).toBe('nested/a.cs');
    expect(t?.comments[0].author).toBeNull();
  });
});

describe('parseThreads', () => {
  it('maps the value array and skips non-thread entries', () => {
    const threads = parseThreads({
      value: [THREAD, { id: 8, comments: [] }],
    });
    expect(threads).toHaveLength(1);
  });

  it('returns [] when value is not an array', () => {
    expect(parseThreads({})).toEqual([]);
    expect(parseThreads(null)).toEqual([]);
  });
});

describe('buildAddThreadBody', () => {
  it('anchors the comment to the right-side line', () => {
    const body = buildAddThreadBody({ path: 'a.cs', line: 4, body: 'hi' }) as {
      threadContext: { filePath: string; rightFileStart: { line: number } };
      comments: { content: string }[];
    };
    expect(body.threadContext.filePath).toBe('/a.cs');
    expect(body.threadContext.rightFileStart.line).toBe(4);
    expect(body.comments[0].content).toBe('hi');
  });

  it('keeps an already-absolute path', () => {
    const body = buildAddThreadBody({ path: '/x.cs', line: 1, body: 'h' }) as {
      threadContext: { filePath: string };
    };
    expect(body.threadContext.filePath).toBe('/x.cs');
  });

  it('omits the thread context for a PR-level comment', () => {
    const body = buildAddThreadBody({ body: 'general note' }) as {
      threadContext?: unknown;
      status: string;
      comments: { content: string }[];
    };
    expect(body.threadContext).toBeUndefined();
    expect(body.status).toBe('active');
    expect(body.comments[0].content).toBe('general note');
  });
});

describe('createAzureCommentsGateway', () => {
  it('lists threads', async () => {
    const gw = createAzureCommentsGateway(
      deps({ httpGet: async () => resp(200, { value: [THREAD] }) }),
      TARGET,
    );
    const threads = await gw.list();
    expect(threads[0].id).toBe('5');
  });

  it('throws when not signed in', async () => {
    const gw = createAzureCommentsGateway(deps({ token: async () => null }), TARGET);
    await expect(gw.list()).rejects.toThrow(/Not signed in/);
  });

  it('throws when list returns non-200', async () => {
    const gw = createAzureCommentsGateway(
      deps({ httpGet: async () => resp(403) }),
      TARGET,
    );
    await expect(gw.list()).rejects.toThrow(/HTTP 403/);
  });

  it('adds a comment', async () => {
    let sentUrl = '';
    const gw = createAzureCommentsGateway(
      deps({
        httpPost: async (url) => {
          sentUrl = url;
          return resp(200, THREAD);
        },
      }),
      TARGET,
    );
    const thread = await gw.add({ path: 'a.cs', line: 12, body: 'nit' });
    expect(thread.id).toBe('5');
    expect(sentUrl).toContain('/threads?api-version=7.1');
  });

  it('throws when add returns an error status', async () => {
    const gw = createAzureCommentsGateway(
      deps({ httpPost: async () => resp(400) }),
      TARGET,
    );
    await expect(gw.add({ path: 'a.cs', line: 1, body: 'x' })).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it('throws when add returns an unmappable thread', async () => {
    const gw = createAzureCommentsGateway(
      deps({ httpPost: async () => resp(200, { id: 1, comments: [] }) }),
      TARGET,
    );
    await expect(gw.add({ path: 'a.cs', line: 1, body: 'x' })).rejects.toThrow(
      /did not return/,
    );
  });

  it('sets status and maps the returned thread', async () => {
    const gw = createAzureCommentsGateway(
      deps({
        httpPatch: async () => resp(200, { ...THREAD, status: 'closed' }),
      }),
      TARGET,
    );
    const updated = await gw.setStatus('5', 'resolved');
    expect(updated.status).toBe('resolved');
  });

  it('falls back to a synthetic thread when patch body is unmappable', async () => {
    const gw = createAzureCommentsGateway(
      deps({ httpPatch: async () => resp(200, {}) }),
      TARGET,
    );
    const updated = await gw.setStatus('5', 'active');
    expect(updated).toEqual({
      id: '5',
      path: null,
      line: null,
      status: 'active',
      comments: [],
    });
  });

  it('throws when patch returns an error status', async () => {
    const gw = createAzureCommentsGateway(
      deps({ httpPatch: async () => resp(500) }),
      TARGET,
    );
    await expect(gw.setStatus('5', 'active')).rejects.toThrow(/HTTP 500/);
  });
});
