import { describe, expect, it } from 'vitest';
import type { Repository } from '../repo/repo-contract.js';
import type {
  AddPrCommentInput,
  PrCommentThread,
  PrCommentThreadStatus,
  PrCommentsGateway,
  PrCommentsGatewayResolver,
} from './pr-comments-contract.js';
import type { PrReview, PrReviewPull } from './pr-review-contract.js';
import {
  assertAddCommentInput,
  assertThreadStatus,
  createPrCommentsService,
} from './pr-comments-service.js';

function repo(id: string): Repository {
  return {
    id,
    provider: 'github',
    remoteUrl: 'https://github.com/acme/widgets.git',
    name: 'acme/widgets',
    localPath: `/repos/${id}`,
    defaultBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function review(featureId: string, repoId: string): PrReview {
  const pull: PrReviewPull = {
    number: 7,
    title: 'Add widget',
    url: 'https://github.com/acme/widgets/pull/7',
  };
  return {
    featureId,
    repoId,
    pull,
  } as unknown as PrReview;
}

function thread(id: string): PrCommentThread {
  return { id, path: 'a.cs', line: 3, status: 'active', comments: [] };
}

interface RecordingGateway extends PrCommentsGateway {
  calls: string[];
}

function recordingGateway(): RecordingGateway {
  const calls: string[] = [];
  return {
    calls,
    list: async () => {
      calls.push('list');
      return [thread('t1')];
    },
    add: async (input: AddPrCommentInput) => {
      calls.push(`add:${input.path}:${input.line}:${input.body}`);
      return thread('created');
    },
    setStatus: async (id: string, status: PrCommentThreadStatus) => {
      calls.push(`setStatus:${id}:${status}`);
      return { ...thread(id), status };
    },
  };
}

function resolver(
  gateway: PrCommentsGateway,
  onResolve?: (repo: Repository, pull: PrReviewPull) => void,
): PrCommentsGatewayResolver {
  return {
    resolve: (r, p) => {
      onResolve?.(r, p);
      return gateway;
    },
  };
}

function setup(options: {
  reviews?: Map<string, PrReview>;
  repos?: Map<string, Repository>;
  gateway?: PrCommentsGateway;
  onResolve?: (repo: Repository, pull: PrReviewPull) => void;
}) {
  const reviews = options.reviews ?? new Map<string, PrReview>();
  const repos = options.repos ?? new Map<string, Repository>();
  const gateway = options.gateway ?? recordingGateway();
  const service = createPrCommentsService({
    reviews: { get: (id) => reviews.get(id) ?? null },
    repos: { get: (id) => repos.get(id) ?? null },
    gateways: resolver(gateway, options.onResolve),
  });
  return { service, gateway };
}

describe('assertThreadStatus', () => {
  it('accepts active and resolved', () => {
    expect(assertThreadStatus('active')).toBe('active');
    expect(assertThreadStatus('resolved')).toBe('resolved');
  });

  it('rejects anything else', () => {
    expect(() => assertThreadStatus('closed')).toThrow(/Unknown thread status/);
  });
});

describe('assertAddCommentInput', () => {
  it('preserves the optional head without changing the edited text or coordinates', () => {
    const input = { path: 'src/a.cs', line: 42, body: '  edited\ncomment  ', expectedHeadSha: 'captured' };
    expect(assertAddCommentInput(input)).toEqual(input);
  });

  it.each([null, 42, '', '  ', {}])('rejects malformed optional head %j', (expectedHeadSha) => {
    expect(() => assertAddCommentInput({
      path: 'a.cs', line: 1, body: 'comment', expectedHeadSha,
    })).toThrow(/expectedHeadSha/);
  });
  it('accepts a well-formed payload', () => {
    expect(
      assertAddCommentInput({ path: 'a.cs', line: 4, body: 'nit' }),
    ).toEqual({ path: 'a.cs', line: 4, body: 'nit' });
  });

  it('defaults a missing body object to an empty object before validating', () => {
    expect(() => assertAddCommentInput(undefined)).toThrow(/file "path"/);
  });

  it.each([
    [{ line: 1, body: 'x' }, /file "path"/],
    [{ path: '   ', line: 1, body: 'x' }, /file "path"/],
    [{ path: 'a', body: 'x' }, /"line"/],
    [{ path: 'a', line: 0, body: 'x' }, /"line"/],
    [{ path: 'a', line: 1.5, body: 'x' }, /"line"/],
    [{ path: 'a', line: 1 }, /comment "body"/],
    [{ path: 'a', line: 1, body: '  ' }, /comment "body"/],
  ])('rejects %j', (payload, message) => {
    expect(() => assertAddCommentInput(payload)).toThrow(message);
  });
});

describe('createPrCommentsService', () => {
  const guardedInput = { path: 'a.cs', line: 12, body: ' edited comment\n', expectedHeadSha: 'captured' };
  function capturedReview(): PrReview {
    return {
      ...review('f1', 'r1'), headSha: 'captured',
      changeGraph: {
        status: 'ready', nodes: [
          { path: 'other.cs', kind: 'changed', diff: '@@ -1 +12 @@\n+x' },
          { path: 'a.cs', kind: 'changed', changeKind: 'modified', diff: '@@ -3,2 +11,2 @@\n context\n-old\n+edited' },
        ],
      },
    } as PrReview;
  }

  it('posts the exact edited body and captured right-side coordinates with the head guard', async () => {
    let received: AddPrCommentInput | undefined;
    const gateway = recordingGateway();
    gateway.add = async (input) => { received = input; return thread('created'); };
    const { service } = setup({
      reviews: new Map([['f1', capturedReview()]]), repos: new Map([['r1', repo('r1')]]), gateway,
    });
    expect(await service.add('f1', guardedInput)).toEqual(thread('created'));
    expect(received).toEqual(guardedInput);
  });

  it.each([
    ['missing head', (r: PrReview) => { r.headSha = null; }, /head/],
    ['changed head', (r: PrReview) => { r.headSha = 'new'; }, /head/],
    ['pending graph', (r: PrReview) => { r.changeGraph.status = 'pending'; }, /not ready/],
    ['failed graph', (r: PrReview) => { r.changeGraph.status = 'failed'; }, /not ready/],
    ['generating graph', (r: PrReview) => { r.changeGraph.status = 'generating'; }, /not ready/],
    ['missing exact file', (r: PrReview) => { r.changeGraph.nodes[1].path = 'A.cs'; }, /exact file/],
    ['boundary file', (r: PrReview) => { r.changeGraph.nodes[1].kind = 'boundary'; }, /exact file/],
    ['deleted file', (r: PrReview) => { r.changeGraph.nodes[1].changeKind = 'deleted'; }, /exact file/],
    ['missing diff', (r: PrReview) => { r.changeGraph.nodes[1].diff = ''; }, /exact file/],
    ['uncaptured line', (r: PrReview) => { r.changeGraph.nodes[1].diff = '@@ -3,20 +11,20 @@\n context'; }, /exact file/],
  ] as const)('blocks %s before gateway resolution', async (_name, change, message) => {
    const saved = capturedReview();
    change(saved);
    let resolved = false;
    const { service, gateway } = setup({
      reviews: new Map([['f1', saved]]), repos: new Map([['r1', repo('r1')]]),
      onResolve: () => { resolved = true; },
    });
    await expect(service.add('f1', guardedInput)).rejects.toThrow(message);
    expect(resolved).toBe(false);
    expect((gateway as RecordingGateway).calls).toEqual([]);
  });

  it.each([
    { expectedHeadSha: '' }, { expectedHeadSha: null }, { path: '../a.cs' },
    { path: '/a.cs' }, { line: 0 }, { line: 1.2 }, { body: '' },
  ])('validates guarded direct service calls %j without posting', async (override) => {
    const { service, gateway } = setup({
      reviews: new Map([['f1', capturedReview()]]), repos: new Map([['r1', repo('r1')]]),
    });
    await expect(service.add('f1', { ...guardedInput, ...override } as AddPrCommentInput)).rejects.toThrow();
    expect((gateway as RecordingGateway).calls).toEqual([]);
  });

  it('does not retry or hide a guarded provider failure', async () => {
    let calls = 0;
    const gateway = recordingGateway();
    gateway.add = async () => { calls += 1; throw new Error('live head moved'); };
    const { service } = setup({
      reviews: new Map([['f1', capturedReview()]]), repos: new Map([['r1', repo('r1')]]), gateway,
    });
    await expect(service.add('f1', guardedInput)).rejects.toThrow('live head moved');
    expect(calls).toBe(1);
  });
  it('lists threads via the resolved gateway', async () => {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    const { service, gateway } = setup({ reviews, repos });
    const threads = await service.list('f1');
    expect(threads).toHaveLength(1);
    expect((gateway as RecordingGateway).calls).toEqual(['list']);
  });

  it('passes the repo and pull to the resolver', async () => {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    let seen: { repo: Repository; pull: PrReviewPull } | null = null;
    const { service } = setup({
      reviews,
      repos,
      onResolve: (r, p) => {
        seen = { repo: r, pull: p };
      },
    });
    await service.list('f1');
    expect(seen).not.toBeNull();
    expect(seen!.repo.id).toBe('r1');
    expect(seen!.pull.number).toBe(7);
  });

  it('adds a comment via the gateway', async () => {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    const { service, gateway } = setup({ reviews, repos });
    const created = await service.add('f1', {
      path: 'a.cs',
      line: 5,
      body: 'looks good',
    });
    expect(created.id).toBe('created');
    expect((gateway as RecordingGateway).calls).toEqual([
      'add:a.cs:5:looks good',
    ]);
  });

  it('sets a thread status via the gateway', async () => {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    const { service, gateway } = setup({ reviews, repos });
    const updated = await service.setStatus('f1', 't9', 'resolved');
    expect(updated.status).toBe('resolved');
    expect((gateway as RecordingGateway).calls).toEqual([
      'setStatus:t9:resolved',
    ]);
  });

  it('rejects an empty threadId before touching the gateway', async () => {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    const { service, gateway } = setup({ reviews, repos });
    await expect(service.setStatus('f1', '  ', 'active')).rejects.toThrow(
      /"threadId"/,
    );
    expect((gateway as RecordingGateway).calls).toEqual([]);
  });

  it('throws when the feature has no review', async () => {
    const { service } = setup({});
    await expect(service.list('missing')).rejects.toThrow(
      /No code review for feature missing/,
    );
  });

  it('throws when the review references an unknown repository', async () => {
    const reviews = new Map([['f1', review('f1', 'gone')]]);
    const { service } = setup({ reviews });
    await expect(service.list('f1')).rejects.toThrow(/No repository gone/);
  });
});
