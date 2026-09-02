import { describe, expect, it } from 'vitest';
import { createEventBus } from '../kernel/event-bus.js';
import type { Clock } from '../kernel/clock.js';
import type { MetaRequest } from '../meta/meta-runner.js';
import type { RemotePullRequest } from '../repo/remote-pr-contract.js';
import { prReviewDefaults } from './config.js';
import type {
  MetaUsage,
  PrDiff,
  PrDiffRequest,
  PrReview,
  PrReviewEventMap,
  PrReviewRepo,
  StartPrReviewInput,
} from './pr-review-contract.js';
import { createPrReviewService } from './pr-review-service.js';
import { createLanguageAnalyzerRegistry } from './language-analyzer.js';
import { createCSharpAnalyzer } from './csharp-analyzer.js';
import type { ChangeGraphFs } from './change-graph-fs.js';

function stepClock(): Clock {
  let tick = 0;
  const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  return { now: at, isoNow: () => at().toISOString() };
}

function memoryRepo(): PrReviewRepo & { rows: Map<string, PrReview> } {
  const rows = new Map<string, PrReview>();
  return {
    rows,
    get: (featureId) => rows.get(featureId) ?? null,
    listAll: () => [...rows.values()],
    findFeatureByPull: (repoId, pullNumber) => {
      for (const review of rows.values()) {
        if (review.repoId === repoId && review.pull.number === pullNumber) {
          return review.featureId;
        }
      }
      return null;
    },
    save: (review) => {
      rows.set(review.featureId, review);
    },
    delete: (featureId) => {
      rows.delete(featureId);
    },
  };
}

const pull: RemotePullRequest = {
  provider: 'github',
  number: 7,
  title: 'Add retry logic',
  url: 'https://example.com/pr/7',
  sourceBranch: 'feature/retry',
  author: 'octocat',
  body: 'Requests fail transiently and users lose data.',
};

const startInput: StartPrReviewInput = {
  featureId: 'f1',
  repoId: 'r1',
  pull,
  worktreePath: 'C:\\work\\pr-7',
  headSha: 'headsha012345',
  baseBranch: 'main',
};

// A C# diff so the change-graph builder produces a real reference edge:
// Service.cs references the Store type that Store.cs declares.
const diff: PrDiff = {
  baseRef: 'origin/main',
  changedFiles: 2,
  files: ['src/Service.cs', 'src/Store.cs'],
  entries: [
    { path: 'src/Service.cs', status: 'modified', patch: '@@ -1 +1 @@\n-class Service { }\n+class Service { Store store; }' },
    { path: 'src/Store.cs', status: 'added', patch: '@@ -0,0 +1 @@\n+new' },
  ],
  stat: ' src/Service.cs | 2 +-',
  patch: '@@ -1 +1 @@\n-old\n+new',
  truncated: false,
};

const worktreeFiles: Record<string, string> = {
  'src/Service.cs': 'namespace App;\nclass Service { Store store; }',
  'src/Store.cs': 'namespace App;\nclass Store { }',
};

const dirListing: Record<string, string[]> = {
  src: ['App.csproj'],
};

/** A fake worktree filesystem backed by in-memory maps. */
function fakeFs(
  files: Record<string, string> = worktreeFiles,
  dirs: Record<string, string[]> = dirListing,
  tree: Record<string, string[]> = {},
): ChangeGraphFs {
  return {
    readFile: async (_worktree, path) => files[path] ?? null,
    listDir: async (_worktree, dir) => dirs[dir] ?? [],
    listFilesRecursive: async (_worktree, dir) => tree[dir] ?? [],
  };
}

/** The only AI step left is the problem statement; the graph is deterministic. */
function defaultProblemText(): string {
  return '## Problem Statement\nRequests fail transiently.';
}

function harness(options: {
  text?: (prompt: string) => string;
  aiError?: Error;
  aiErrorSequence?: (Error | null)[];
  diffError?: Error;
  fs?: ChangeGraphFs;
  usage?: (sessionId: string) => MetaUsage | null;
  activityLines?: number;
  inlinePrompts?: boolean;
  config?: typeof prReviewDefaults;
} = {}) {
  const reviews = memoryRepo();
  const bus = createEventBus<PrReviewEventMap>();
  const events: PrReview[] = [];
  bus.on('pr.review.updated', (review) => events.push(review));
  const diffRequests: PrDiffRequest[] = [];
  const prompts: string[] = [];
  const attachmentContents = new Map<string, string>();
  const cleanups: string[] = [];
  const sleeps: number[] = [];
  let session = 0;
  let attachment = 0;
  let aiCall = 0;
  const service = createPrReviewService({
    reviews,
    bus,
    clock: stepClock(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    config: options.config ?? prReviewDefaults,
    inlinePrompts: options.inlinePrompts,
    analyzers: createLanguageAnalyzerRegistry([createCSharpAnalyzer()]),
    changeGraphFs: options.fs ?? fakeFs(),
    diffs: {
      collect: async (request) => {
        diffRequests.push(request);
        if (options.diffError) throw options.diffError;
        return diff;
      },
    },
    metaUsage: {
      usageForSession: (sessionId) =>
        options.usage
          ? options.usage(sessionId)
          : {
              sessionId,
              inputTokens: 10,
              outputTokens: 5,
              nanoAiu: 1,
              credits: 2,
            },
    },
    temporaryPrompts: {
      create: async (content, repositoryPath) => {
        const path = `${repositoryPath}\\att-${attachment++}.pdf`;
        attachmentContents.set(path, content);
        return {
          path,
          cleanup: async () => {
            cleanups.push(path);
          },
        };
      },
    },
    ai: {
      runDetailed: async (request: MetaRequest) => {
        // The real step prompt travels as the attachment, not inline argv.
        const attached = request.attachments?.[0] ?? '';
        const realPrompt = attachmentContents.get(attached) ?? request.prompt;
        prompts.push(realPrompt);
        const sequenced = options.aiErrorSequence?.[aiCall] ?? null;
        aiCall += 1;
        if (options.aiError) throw options.aiError;
        if (sequenced) throw sequenced;
        const sessionId = `meta-${session++}`;
        request.onStart?.(sessionId);
        const lines = options.activityLines ?? 1;
        for (let i = 0; i < lines; i += 1) {
          request.onActivity?.(`💬 working ${i}`);
        }
        return {
          text: (options.text ?? defaultProblemText)(realPrompt),
          sessionId,
        };
      },
    },
  });
  return { service, reviews, events, diffRequests, prompts, cleanups, sleeps };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createPrReviewService', () => {
  it('runs the problem statement via AI and builds the change graph deterministically', async () => {
    const h = harness({ config: { ...prReviewDefaults, coldInlineMaxChars: 0 } });
    const started = h.service.start(startInput);
    expect(started.problemStatement.status).toBe('pending');
    expect(started.changeGraph.status).toBe('pending');
    expect(started.description).toBe(
      'Requests fail transiently and users lose data.',
    );

    await settle();

    const ready = h.service.get('f1');
    expect(ready.problemStatement.status).toBe('ready');
    expect(ready.problemStatement.content).toBe('Requests fail transiently.');
    expect(ready.problemStatement.sufficient).toBe(true);

    expect(ready.changeGraph.status).toBe('ready');
    expect(ready.changeGraph.nodes.map((n) => n.path)).toEqual([
      'src/Service.cs',
      'src/Store.cs',
    ]);
    // Every changed file groups into its .csproj project box.
    expect(ready.changeGraph.projects).toEqual([
      { id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' },
    ]);
    // Service.cs references the Store type Store.cs declares → a reference edge.
    expect(ready.changeGraph.edges).toEqual([
      {
        from: 'src/Service.cs',
        to: 'src/Store.cs',
        calls: [{ symbol: 'Store', caller: null }],
      },
    ]);
    // The deterministic step never runs a metasession.
    expect(ready.changeGraph.metaSessionId).toBeNull();
    expect(ready.changeGraph.usage).toBeNull();
    expect(ready.changedFiles).toBe(2);

    expect(ready.problemStatement.activity).toContain('💬 working 0');
    expect(ready.problemStatement.metaSessionId).toBeTruthy();

    expect(h.diffRequests).toEqual([
      { worktreePath: 'C:\\work\\pr-7', baseBranch: 'main' },
    ]);
    // Only the problem-statement prompt is delivered as an attachment; the
    // change graph runs no AI, so exactly one attachment is cleaned up.
    expect(h.cleanups.length).toBe(1);
    expect(h.prompts.length).toBe(1);
  });

  it('sends the problem-statement prompt inline and skips attachments when inlinePrompts is set', async () => {
    const h = harness({ inlinePrompts: true });
    h.service.start(startInput);
    await settle();

    const ready = h.service.get('f1');
    expect(ready.problemStatement.status).toBe('ready');
    expect(ready.changeGraph.status).toBe('ready');
    // No temp-file attachments are created or cleaned up on the warm path.
    expect(h.cleanups.length).toBe(0);
    expect(h.prompts[0]).toContain('Problem Statement');
  });

  it('caps the per-step activity log so a chatty metasession stays bounded', async () => {
    const h = harness({ activityLines: 80 });
    h.service.start(startInput);
    await settle();

    const ready = h.service.get('f1');
    expect(ready.problemStatement.activity.length).toBe(60);
    expect(ready.problemStatement.activity[0]).toBe('💬 working 20');
    expect(ready.problemStatement.activity.at(-1)).toBe('💬 working 79');
  });

  it('enriches the ready problem statement with its metasession usage', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();

    const ready = h.service.get('f1');
    expect(ready.problemStatement.metaSessionId).toBe('meta-0');
    expect(ready.problemStatement.usage).toEqual({
      sessionId: 'meta-0',
      inputTokens: 10,
      outputTokens: 5,
      nanoAiu: 1,
      credits: 2,
    });
  });

  it('leaves usage null for steps that never ran', () => {
    const h = harness();
    const started = h.service.start(startInput);
    expect(started.problemStatement.metaSessionId).toBeNull();
    expect(started.problemStatement.usage).toBeNull();
  });

  it('marks the problem statement insufficient without inventing one', async () => {
    const h = harness({
      text: () => 'INSUFFICIENT: the description is empty',
    });
    h.service.start(startInput);
    await settle();

    const ready = h.service.get('f1');
    expect(ready.problemStatement.sufficient).toBe(false);
    expect(ready.problemStatement.content).toBe('the description is empty');
  });

  it('fails only the problem statement and keeps the change graph', async () => {
    const h = harness({ aiError: new Error('provider exited 1') });
    h.service.start(startInput);
    await settle();

    const review = h.service.get('f1');
    expect(review.problemStatement.status).toBe('failed');
    expect(review.problemStatement.failure?.message).toBe('provider exited 1');
    expect(review.changeGraph.status).toBe('ready');
  });

  it('retries a transient provider failure and recovers the problem statement', async () => {
    const h = harness({
      aiErrorSequence: [
        new Error(
          'Provider failed (exit code 1): Failed to fetch GitHub CLI user login (503): No server is currently available',
        ),
        null,
      ],
    });
    h.service.start(startInput);
    await settle();

    const review = h.service.get('f1');
    expect(review.problemStatement.status).toBe('ready');
    expect(review.problemStatement.content).toBe('Requests fail transiently.');
    // One backoff was waited before the successful second attempt.
    expect(h.sleeps).toEqual([prReviewDefaults.transientRetryBackoffMs]);
    // A retry notice was surfaced in the step's live activity.
    expect(
      review.problemStatement.activity.some((line) =>
        line.startsWith('Provider unavailable — retrying (attempt 2)'),
      ),
    ).toBe(true);
  });

  it('fails after exhausting the transient retry budget', async () => {
    const transient = new Error('Provider failed (exit code 1): 503 service unavailable');
    const h = harness({
      aiErrorSequence: [transient, transient, transient, transient],
    });
    h.service.start(startInput);
    await settle();

    const review = h.service.get('f1');
    expect(review.problemStatement.status).toBe('failed');
    // Two backoffs waited across the two retries, then it gave up.
    expect(h.sleeps).toHaveLength(prReviewDefaults.transientRetryAttempts);
  });

  it('does not retry a provider timeout', async () => {
    const h = harness({
      aiErrorSequence: [new Error('Provider timed out after 120000ms')],
    });
    h.service.start(startInput);
    await settle();

    const review = h.service.get('f1');
    expect(review.problemStatement.status).toBe('failed');
    expect(h.sleeps).toEqual([]);
  });

  it('reports a generic message for non-Error failures', async () => {
    const reviews = memoryRepo();
    const bus = createEventBus<PrReviewEventMap>();
    const service = createPrReviewService({
      reviews,
      bus,
      clock: stepClock(),
      sleep: async () => {},
      config: prReviewDefaults,
      analyzers: createLanguageAnalyzerRegistry([createCSharpAnalyzer()]),
      changeGraphFs: fakeFs(),
      diffs: { collect: async () => diff },
      metaUsage: { usageForSession: () => null },
      temporaryPrompts: {
        create: async (_content, repositoryPath) => ({
          path: `${repositoryPath}\\att.pdf`,
          cleanup: async () => {},
        }),
      },
      ai: {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        runDetailed: async () => {
          throw 'boom';
        },
      },
    });
    service.start(startInput);
    await settle();
    expect(service.get('f1').problemStatement.failure?.message).toBe(
      'Code review step failed',
    );
  });

  it('fails the change graph when diff collection fails', async () => {
    const h = harness({ diffError: new Error('git failed') });
    h.service.start(startInput);
    await settle();

    const review = h.service.get('f1');
    expect(review.problemStatement.status).toBe('ready');
    expect(review.changeGraph.status).toBe('failed');
    expect(review.changeGraph.failure?.message).toBe('git failed');
  });

  it('find returns null and get throws when no review exists', () => {
    const h = harness();
    expect(h.service.find('missing')).toBeNull();
    expect(() => h.service.get('missing')).toThrow(/not available/);
  });

  it('find returns an enriched review when one exists', () => {
    const h = harness();
    h.service.start(startInput);
    const review = h.service.find(startInput.featureId);
    expect(review).not.toBeNull();
    expect(review?.featureId).toBe(startInput.featureId);
  });

  it('findByPull resolves an existing PR review to its feature id', () => {
    const h = harness();
    h.service.start(startInput);
    expect(h.service.findByPull('r1', 7)).toBe('f1');
    expect(h.service.findByPull('r1', 999)).toBeNull();
    expect(h.service.findByPull('other', 7)).toBeNull();
  });

  it('refresh re-runs an existing review and preserves createdAt', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();
    const first = h.service.get('f1');

    const refreshed = h.service.refresh('f1');
    expect(refreshed.problemStatement.status).toBe('pending');
    expect(refreshed.timestamps.createdAt).toBe(first.timestamps.createdAt);
    await settle();
    expect(h.service.get('f1').changeGraph.status).toBe('ready');
  });

  it('refresh rejects when no review exists', () => {
    const h = harness();
    expect(() => h.service.refresh('missing')).toThrow(/not available/);
  });

  it('refresh preempts an in-flight generation and repopulates', async () => {
    const h = harness();
    h.service.start(startInput);
    const refreshed = h.service.refresh('f1');
    expect(refreshed.problemStatement.status).toBe('pending');
    expect(refreshed.changeGraph.status).toBe('pending');
    await settle();
    const review = h.service.get('f1');
    expect(review.problemStatement.status).toBe('ready');
    expect(review.changeGraph.status).toBe('ready');
  });

  it('retries a single step against the stored review, collecting its own diff', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();
    const diffCallsAfterStart = h.diffRequests.length;

    const retried = h.service.retryStep('f1', 'changeGraph');
    expect(retried.problemStatement.status).toBe('ready');
    await settle();
    expect(h.service.get('f1').changeGraph.status).toBe('ready');
    // The retried change-graph step collects the diff again on its own.
    expect(h.diffRequests.length).toBe(diffCallsAfterStart + 1);
  });

  it('retries each of the two steps', async () => {
    for (const step of ['problemStatement', 'changeGraph'] as const) {
      const h = harness();
      h.service.start(startInput);
      await settle();
      h.service.retryStep('f1', step);
      await settle();
      expect(h.service.get('f1')[step].status).toBe('ready');
    }
  });

  it('retryStep rejects an unknown step', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();
    expect(() =>
      h.service.retryStep('f1', 'nope' as 'changeGraph'),
    ).toThrow(/Unknown PR review step/);
  });

  it('retryStep rejects when no review exists', () => {
    const h = harness();
    expect(() => h.service.retryStep('missing', 'changeGraph')).toThrow(
      /not available/,
    );
  });

  it('retryStep preempts an in-flight generation for that step', async () => {
    const h = harness();
    h.service.start(startInput);
    h.service.retryStep('f1', 'changeGraph');
    await settle();
    expect(h.service.get('f1').changeGraph.status).toBe('ready');
  });

  it('preserves the original createdAt when starting over an existing review', async () => {
    const h = harness();
    const seeded: PrReview = {
      featureId: 'f1',
      repoId: 'r1',
      pull: { number: 7, title: 'old', url: 'u' },
      worktreePath: 'C:\\work\\pr-7',
      headSha: null,
      baseBranch: 'main',
      description: null,
      problemStatement: {
        status: 'failed',
        metaSessionId: null,
        usage: null,
        failure: { message: 'old', failedAt: '2020-01-01T00:00:00.000Z' },
        activity: [],
        generatedAt: null,
        content: null,
        sufficient: true,
      },
      changeGraph: {
        status: 'pending',
        metaSessionId: null,
        usage: null,
        failure: null,
        activity: [],
        generatedAt: null,
        projects: [],
        nodes: [],
        edges: [],
      },
      changedFiles: null,
      timestamps: {
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    };
    h.reviews.save(seeded);

    const started = h.service.start(startInput);
    expect(started.timestamps.createdAt).toBe('2020-01-01T00:00:00.000Z');
    await settle();
  });

  it('removeForFeature deletes the review and suppresses a late job publish', async () => {
    const h = harness();
    h.service.start(startInput);
    h.service.removeForFeature('f1');
    await settle();

    expect(h.service.find('f1')).toBeNull();
    expect(h.reviews.rows.has('f1')).toBe(false);
  });

  it('explains a placeholder file on demand and caches the result', async () => {
    const text = (prompt: string): string => {
      if (prompt.includes('single changed file')) {
        return JSON.stringify({
          whatItDoes: 'Runs the store.',
          whatChanged: 'Store now retries.',
          review: ['Consider adding a test for the retry path.'],
        });
      }
      return defaultProblemText();
    };
    const h = harness({ text });
    h.service.start(startInput);
    await settle();

    // The deterministic builder writes placeholder descriptions for every node.
    const before = h.service.get('f1').changeGraph.nodes.find(
      (n) => n.path === 'src/Store.cs',
    );
    expect(before?.whatItDoes).toMatch(/No description/);
    const promptsBefore = h.prompts.length;

    const updated = await h.service.explainFile('f1', 'src/Store.cs');
    const node = updated.changeGraph.nodes.find((n) => n.path === 'src/Store.cs');
    expect(node?.whatItDoes).toBe('Runs the store.');
    expect(node?.whatChanged).toBe('Store now retries.');
    expect(node?.review).toEqual(['Consider adding a test for the retry path.']);
    // The other node, untouched, keeps its placeholder.
    expect(
      updated.changeGraph.nodes.find((n) => n.path === 'src/Service.cs')
        ?.whatItDoes,
    ).toMatch(/No description/);
    expect(h.prompts.length).toBe(promptsBefore + 1);

    // Second call serves from cache without running another metasession.
    await h.service.explainFile('f1', 'src/Store.cs');
    expect(h.prompts.length).toBe(promptsBefore + 1);
  });

  it('defaults the description to null when the PR has no body', async () => {
    const h = harness();
    const started = h.service.start({
      ...startInput,
      pull: { ...pull, body: undefined },
    });
    expect(started.description).toBeNull();
    await settle();
  });

  it('treats explainFile on a boundary caller node as a no-op', async () => {
    const files = {
      ...worktreeFiles,
      'src/Caller.cs': 'namespace App.Web;\nclass Caller { Store s; }',
    };
    const h = harness({
      fs: fakeFs(files, dirListing, { '': ['src/Caller.cs'] }),
    });
    h.service.start(startInput);
    await settle();
    const promptsBefore = h.prompts.length;

    const updated = await h.service.explainFile('f1', 'src/Caller.cs');
    const node = updated.changeGraph.nodes.find((n) => n.path === 'src/Caller.cs');
    expect(node?.kind).toBe('boundary');
    expect(node?.whatChanged).toBe('');
    expect(h.prompts.length).toBe(promptsBefore);
  });

  it('explainFile rejects when the review is missing', async () => {
    const h = harness();
    await expect(h.service.explainFile('missing', 'a.ts')).rejects.toThrow(
      /not available/,
    );
  });

  it('explainFile rejects when the file is not in the change graph', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();
    await expect(h.service.explainFile('f1', 'nope.ts')).rejects.toThrow(
      /not in the change graph/,
    );
  });

  it('reads the full worktree content of a file in the change graph', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();
    const result = await h.service.getFileContent('f1', 'src/Store.cs');
    expect(result).toEqual({
      path: 'src/Store.cs',
      content: 'namespace App;\nclass Store { }',
    });
  });

  it('returns null content when the worktree file cannot be read', async () => {
    const h = harness({ fs: fakeFs({}) });
    h.service.start(startInput);
    await settle();
    const result = await h.service.getFileContent('f1', 'src/Store.cs');
    expect(result).toEqual({ path: 'src/Store.cs', content: null });
  });

  it('getFileContent rejects when the review is missing', async () => {
    const h = harness();
    await expect(h.service.getFileContent('missing', 'a.ts')).rejects.toThrow(
      /not available/,
    );
  });

  it('getFileContent rejects when the file is not in the change graph', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();
    await expect(h.service.getFileContent('f1', 'nope.ts')).rejects.toThrow(
      /not in the change graph/,
    );
  });

  it('answers a change-graph chat question grounded in the diagram', async () => {
    const text = (prompt: string): string => {
      if (prompt.includes('Reviewer question')) {
        return '  Two modules changed: Store and Service.  ';
      }
      return defaultProblemText();
    };
    const h = harness({ text });
    h.service.start(startInput);
    await settle();
    const promptsBefore = h.prompts.length;

    const reply = await h.service.chatAboutGraph('f1', 'code', [
      { role: 'user', content: 'What changed?' },
    ]);
    expect(reply.answer).toBe('Two modules changed: Store and Service.');
    // The chat prompt embeds the diagram summary and runs one metasession.
    expect(h.prompts.length).toBe(promptsBefore + 1);
    expect(h.prompts[h.prompts.length - 1]).toContain('Change graph (code)');
  });

  it('parses a diagram overlay from a chat answer and validates its paths', async () => {
    const text = (prompt: string): string => {
      if (prompt.includes('Reviewer question')) {
        return (
          'Service calls into Store.\n\n' +
          '```pr-graph\n' +
          JSON.stringify({
            highlight: ['src/Service.cs', 'ghost.cs'],
            focusFlow: ['src/Service.cs', 'src/Store.cs'],
            notes: [{ path: 'src/Store.cs', text: 'data layer' }],
          }) +
          '\n```'
        );
      }
      return defaultProblemText();
    };
    const h = harness({ text });
    h.service.start(startInput);
    await settle();

    const reply = await h.service.chatAboutGraph('f1', 'code', [
      { role: 'user', content: 'Show the flow.' },
    ]);
    // Prose is stripped of the block; the ghost path is dropped as it is not a node.
    expect(reply.answer).toBe('Service calls into Store.');
    expect(reply.annotations).toEqual({
      highlight: ['src/Service.cs'],
      focusFlow: ['src/Service.cs', 'src/Store.cs'],
      notes: [{ path: 'src/Store.cs', text: 'data layer' }],
    });
  });

  it('chatAboutGraph rejects when the review is missing', async () => {
    const h = harness();
    await expect(
      h.service.chatAboutGraph('missing', 'code', [
        { role: 'user', content: 'Hi' },
      ]),
    ).rejects.toThrow(/not available/);
  });

  it('grounds the file explanation on the description, then the title', async () => {
    const node = {
      path: 'src/Store.cs',
      projectId: 'src/App.csproj',
      module: 'App',
      category: 'code' as const,
      kind: 'changed' as const,
      changeKind: 'added' as const,
      diff: '@@ +1 @@',
      whatItDoes: 'No description was produced for this file.',
      whatChanged: 'No change summary was produced for this file.',
      review: [],
    };
    const seed = (description: string | null): PrReview => ({
      featureId: 'f1',
      repoId: 'r1',
      pull: { number: 7, title: 'Fallback title', url: 'u' },
      worktreePath: 'C:\\work\\pr-7',
      headSha: null,
      baseBranch: 'main',
      description,
      problemStatement: {
        status: 'ready',
        metaSessionId: null,
        usage: null,
        failure: null,
        activity: [],
        generatedAt: null,
        content: null,
        sufficient: true,
      },
      changeGraph: {
        status: 'ready',
        metaSessionId: null,
        usage: null,
        failure: null,
        activity: [],
        generatedAt: null,
        projects: [{ id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' }],
        nodes: [node],
        edges: [],
      },
      changedFiles: null,
      timestamps: {
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    });

    const h = harness();
    h.reviews.save(seed('Grounding description'));
    await h.service.explainFile('f1', 'src/Store.cs');
    expect(h.prompts.at(-1)).toContain('Grounding description');

    h.reviews.save(seed(null));
    await h.service.explainFile('f1', 'src/Store.cs');
    expect(h.prompts.at(-1)).toContain('Fallback title');
  });
});
