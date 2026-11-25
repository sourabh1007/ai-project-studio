import { describe, expect, it } from 'vitest';
import type { PrCommentsServiceDeps } from './pr-comments-service.js';
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
  assertReactInput,
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
    react: async (input) => {
      calls.push(`react:${input.threadId}:${input.commentId}:${input.content}:${input.on}`);
      return {
        id: input.commentId,
        author: null,
        authorAvatarUrl: null,
        body: '',
        createdAt: null,
        reactions: input.on
          ? [{ content: input.content, count: 1, viewerReacted: true }]
          : [],
      };
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
  currentHead?: (featureId: string) => Promise<string | null>;
}) {
  const reviews = options.reviews ?? new Map<string, PrReview>();
  const repos = options.repos ?? new Map<string, Repository>();
  const gateway = options.gateway ?? recordingGateway();
  const service = createPrCommentsService({
    reviews: { get: (id) => reviews.get(id) ?? null },
    repos: { get: (id) => repos.get(id) ?? null },
    gateways: resolver(gateway, options.onResolve),
    currentHead: options.currentHead,
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

  it('accepts a PR-level comment with neither path nor line', () => {
    expect(assertAddCommentInput({ body: 'general note' })).toEqual({ body: 'general note' });
  });

  it('accepts a head-guarded PR-level comment without inventing an anchor', () => {
    expect(assertAddCommentInput({ body: 'x', expectedHeadSha: 'captured' }))
      .toEqual({ body: 'x', expectedHeadSha: 'captured' });
  });
  it.each([
    { expectedRunId: '' }, { expectedAssessmentRevision: 1 },
    { expectedRunId: 'run', expectedAssessmentRevision: -1 },
    { expectedRunId: 'run', expectedAssessmentRevision: 1.5 },
  ])('rejects incomplete or malformed run guards %j', (guards) => {
    expect(() => assertAddCommentInput({ body: 'x', expectedHeadSha: 'head', ...guards })).toThrow(/expectedRunId/);
  });
  it('requires a head when supplying run guards', () => {
    expect(() => assertAddCommentInput({ body: 'x', expectedRunId: 'run', expectedAssessmentRevision: 1 })).toThrow(/expectedHeadSha/);
  });

  it('requires an empty object to fail on the missing body first', () => {
    expect(() => assertAddCommentInput(undefined)).toThrow(/comment "body"/);
  });

  it.each([
    [{ body: 'x', line: 1 }, /Provide both/],
    [{ body: 'x', path: 'a' }, /Provide both/],
    [{ path: '   ', line: 1, body: 'x' }, /file "path"/],
    [{ path: 'a', line: 0, body: 'x' }, /"line"/],
    [{ path: 'a', line: 1.5, body: 'x' }, /"line"/],
    [{ path: 'a', line: 1 }, /comment "body"/],
    [{ path: 'a', line: 1, body: '  ' }, /comment "body"/],
  ])('rejects %j', (payload, message) => {
    expect(() => assertAddCommentInput(payload)).toThrow(message);
  });
});

describe('createPrCommentsService', () => {
  function durable(overrides: Partial<PrCommentsServiceDeps> = {}) {
    const captured = capturedReview();
    captured.reviewBoardRun = { id: 'run', revision: 1, context: { baseSha: 'base', targetBranch: 'main' } } as NonNullable<PrReview['reviewBoardRun']>;
    const records = new Map([['f1', captured]]);
    const gateway = recordingGateway();
    const deps: PrCommentsServiceDeps = {
      reviews: { get: (id) => records.get(id) ?? null, save: (review) => { records.set(review.featureId, review); } },
      repos: { get: () => repo('r1') }, gateways: resolver(gateway),
      clock: { now: () => new Date(0), isoNow: () => 'now' },
      currentRevisions: async () => ({ headSha: 'captured', baseSha: 'base', targetBranch: 'main' }),
      ...overrides,
    };
    const input = { body: 'Please bound this key.', expectedHeadSha: 'captured', expectedRunId: 'run',
      expectedAssessmentRevision: 1, publicationKey: 'finding-1' };
    return { deps, records, gateway, input, service: createPrCommentsService(deps) };
  }
  it('reserves publication durably, shares concurrent sends and reuses confirmed results', async () => {
    const { service, gateway, input, records } = durable();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    gateway.add = async (posted) => {
      calls++;
      expect(records.get('f1')!.reviewPublications![0].status).toBe('pending');
      expect(posted.body).toContain('<!-- studio-review:');
      entered();
      await finish;
      return thread('created');
    };
    const first = service.add('f1', input);
    const second = service.add('f1', input);
    await started;
    await expect(service.reconcilePublication!('f1', input.publicationKey)).rejects.toThrow('still running');
    release();
    await Promise.all([first, second]);
    expect(await service.add('f1', input)).toEqual(thread('created'));
    expect((await service.reconcilePublication!('f1', input.publicationKey)).status).toBe('posted');
    expect(calls).toBe(1);
    expect(service.publications!('f1')[0].input.body).toBe(input.body);
    await expect(service.add('f1', { ...input, body: 'Different content' })).rejects.toThrow('different content');
  });
  it('reconciles an unconfirmed remote side effect across restart without resending', async () => {
    const { service, gateway, input, deps } = durable();
    let sent = '';
    let calls = 0;
    gateway.add = async (posted) => { calls++; sent = posted.body; throw new Error('Lost HTTP response'); };
    await expect(service.add('f1', input)).rejects.toThrow('uncertain');
    expect(service.publications!('f1')[0].status).toBe('uncertain');
    const restarted = createPrCommentsService(deps);
    await expect(restarted.add('f1', input)).rejects.toThrow('uncertain');
    gateway.list = async () => [{ ...thread('remote'), comments: [{
      id: 'comment', author: null, authorAvatarUrl: null, body: sent, createdAt: null, reactions: [],
    }] }];
    expect((await restarted.reconcilePublication!('f1', input.publicationKey)).thread?.id).toBe('remote');
    expect(await restarted.add('f1', input)).toMatchObject({ id: 'remote' });
    expect(calls).toBe(1);
    await expect(restarted.reconcilePublication!('f1', 'unknown')).rejects.toThrow('Unknown');
  });
  it('keeps absent or ambiguous provider matches uncertain and never treats publication as a fix', async () => {
    const { service, gateway, input, records } = durable();
    let sent = '';
    gateway.add = async (posted) => { sent = posted.body; throw new Error('unknown'); };
    await expect(service.add('f1', input)).rejects.toThrow('uncertain');
    gateway.list = async () => [];
    expect((await service.reconcilePublication!('f1', input.publicationKey)).error).toContain('not be resent');
    gateway.list = async () => ['a', 'b'].map((id) => ({ ...thread(id), comments: [{
      id, author: null, authorAvatarUrl: null, body: sent, createdAt: null, reactions: [],
    }] }));
    expect((await service.reconcilePublication!('f1', input.publicationKey)).error).toContain('Multiple');
    records.get('f1')!.reviewPublications![0].status = 'pending';
    await expect(service.add('f1', input)).rejects.toThrow('uncertain');
    records.get('f1')!.reviewPublications![0].status = 'posted';
    delete records.get('f1')!.reviewPublications![0].thread;
    await expect(service.add('f1', input)).rejects.toThrow('uncertain');
    expect(records.get('f1')!.reviewBoardRun!.findingEvents).toBeUndefined();
  });
  it('fails closed before publication on changed target/head, missing storage or exhausted history', async () => {
    const { service, deps, input, records, gateway } = durable({ maxPublications: 1 });
    for (const live of [
      { headSha: 'other', baseSha: 'base', targetBranch: 'main' },
      { headSha: 'captured', baseSha: 'other', targetBranch: 'main' },
      { headSha: 'captured', baseSha: 'base', targetBranch: 'other' },
    ]) {
      deps.currentRevisions = async () => live;
      await expect(service.add('f1', input)).rejects.toThrow('target branch changed');
      expect(service.publications!('f1')).toEqual([]);
    }
    deps.currentRevisions = async () => ({ headSha: 'captured', baseSha: 'base', targetBranch: 'main' });
    delete records.get('f1')!.reviewBoardRun!.context.targetBranch;
    await service.add('f1', input);
    await expect(service.add('f1', { ...input, publicationKey: 'other' })).rejects.toThrow('history is full');
    expect(gateway.calls).toHaveLength(1);
    const noClock = durable({ clock: undefined });
    await expect(noClock.service.add('f1', noClock.input)).rejects.toThrow('storage');
    const noSave = durable();
    delete noSave.deps.reviews.save;
    await expect(noSave.service.add('f1', noSave.input)).rejects.toThrow('storage');
    await expect(service.add('missing', input)).rejects.toThrow('No code review');
    expect(() => service.publications!('missing')).toThrow('No code review');
    const pending = records.get('f1')!.reviewPublications![0];
    pending.status = 'uncertain';
    delete deps.reviews.save;
    await expect(service.reconcilePublication!('f1', input.publicationKey)).rejects.toThrow('storage');
  });
  it('supports guarded publication when a legacy snapshot has no frozen target metadata', async () => {
    const { service, records, input } = durable();
    delete records.get('f1')!.reviewBoardRun;
    await expect(service.add('f1', { body: input.body, expectedHeadSha: input.expectedHeadSha })).resolves.toMatchObject({ id: 'created' });
    expect(service.publications!('f1')).toEqual([]);
  });
  it.each([null, '', ' ', 1, 'x'.repeat(501)])('rejects malformed publication keys %j', (publicationKey) => {
    expect(() => assertAddCommentInput({ body: 'comment', expectedHeadSha: 'head', expectedRunId: 'run',
      expectedAssessmentRevision: 1, publicationKey })).toThrow('publicationKey');
  });
  it('requires complete run guards and a bounded comment for publication', () => {
    expect(() => assertAddCommentInput({ body: 'x', publicationKey: 'key' })).toThrow('publicationKey');
    expect(() => assertAddCommentInput({ body: 'x'.repeat(20_001), expectedRunId: 'r', expectedHeadSha: 'h',
      expectedAssessmentRevision: 0, publicationKey: 'key' })).toThrow('publicationKey');
  });
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
  it('revalidates remote heads and the saved assessment before publishing PR-level comments', async () => {
      const captured = capturedReview();
      captured.reviewBoardRun = { id: 'run', revision: 1 } as NonNullable<PrReview['reviewBoardRun']>;
      const input = { body: 'note', expectedHeadSha: 'captured', expectedRunId: 'run', expectedAssessmentRevision: 1 };
      const gateway = recordingGateway();
      const common = { reviews: new Map([['f1', captured]]), repos: new Map([['r1', repo('r1')]]), gateway };
      const fresh = setup({ ...common, currentHead: async () => 'captured' }).service;
      await expect(fresh.add('f1', { body: 'note', expectedRunId: 'run' })).rejects.toThrow('expectedRunId');
      await expect(fresh.add('f1', { body: 'note', expectedAssessmentRevision: 1 })).rejects.toThrow('expectedRunId');
      await fresh.add('f1', input);
      expect(gateway.calls).toHaveLength(1);
      await expect(setup({ ...common, currentHead: async () => 'new' }).service.add('f1', input)).rejects.toThrow('remote');
      await expect(fresh.add('f1', { ...input, expectedRunId: 'old' })).rejects.toThrow('assessment');
      await expect(fresh.add('f1', { ...input, expectedAssessmentRevision: 0 })).rejects.toThrow('assessment');
      await expect(setup({ ...common, currentHead: async () => {
        captured.reviewBoardRun!.revision++;
        return 'captured';
      } }).service.add('f1', input)).rejects.toThrow('assessment');
      expect(gateway.calls).toHaveLength(1);
      delete captured.reviewBoardRun;
      await expect(fresh.add('f1', input)).rejects.toThrow('assessment');
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

  it('adds a PR-level comment with no anchor and no head guard', async () => {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    const { service, gateway } = setup({ reviews, repos });
    const created = await service.add('f1', { body: 'general note' });
    expect(created.id).toBe('created');
    expect((gateway as RecordingGateway).calls).toEqual([
      'add:undefined:undefined:general note',
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

  it('reacts to a comment via the gateway', async () => {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    const { service, gateway } = setup({ reviews, repos });
    const comment = await service.react('f1', {
      threadId: 't1', commentId: 'c1', content: 'THUMBS_UP', on: true,
    });
    expect(comment.reactions).toEqual([
      { content: 'THUMBS_UP', count: 1, viewerReacted: true },
    ]);
    expect((gateway as RecordingGateway).calls).toEqual([
      'react:t1:c1:THUMBS_UP:true',
    ]);
  });
});

describe('assertReactInput', () => {
  it('accepts a well-formed reaction toggle', () => {
    expect(assertReactInput('t1', 'c1', { content: 'HEART', on: true })).toEqual({
      threadId: 't1', commentId: 'c1', content: 'HEART', on: true,
    });
  });

  it.each(['', '  '])('rejects an empty threadId %j', (threadId) => {
    expect(() => assertReactInput(threadId, 'c1', { content: 'HEART', on: true })).toThrow(
      /"threadId"/,
    );
  });

  it.each(['', '  '])('rejects an empty commentId %j', (commentId) => {
    expect(() => assertReactInput('t1', commentId, { content: 'HEART', on: true })).toThrow(
      /"commentId"/,
    );
  });

  it.each([undefined, 42, 'NOPE', {}])('rejects an invalid content %j', (content) => {
    expect(() => assertReactInput('t1', 'c1', { content, on: true })).toThrow(
      /"content"/,
    );
  });

  it.each([undefined, 'yes', 1])('rejects a non-boolean on flag %j', (on) => {
    expect(() => assertReactInput('t1', 'c1', { content: 'HEART', on })).toThrow(
      /"on"/,
    );
  });

  it('treats a missing body as an invalid content', () => {
    expect(() => assertReactInput('t1', 'c1', undefined)).toThrow(/"content"/);
  });
});
