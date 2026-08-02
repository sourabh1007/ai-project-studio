import { describe, expect, it } from 'vitest';
import { createClock } from '../kernel/clock.js';
import { createEventBus } from '../kernel/event-bus.js';
import type { Repository } from '../repo/repo-contract.js';
import type { RepoService } from '../repo/repo-service.js';
import type {
  RepositoryContext,
  RepositoryEvidence,
} from './repository-context-contract.js';
import {
  createRepositoryContextCoordinator,
  type RepositoryContextEventMap,
} from './repository-context-coordinator.js';

const repository: Repository = {
  id: 'r1',
  provider: 'github',
  remoteUrl: 'https://github.com/acme/app.git',
  name: 'acme/app',
  localPath: 'C:\\work\\app',
  defaultBranch: 'main',
  createdAt: '2026-08-01T00:00:00.000Z',
};

const evidence: RepositoryEvidence = {
  sourceRevision: 'a'.repeat(40),
  tree: 'src/main.ts',
  files: [{ path: 'src/main.ts', content: 'main' }],
  totalFileCount: 1,
  omittedFileCount: 0,
  totalContentChars: 4,
  largeRepository: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Collapses consecutive duplicate statuses so step publishes don't add noise. */
function statusFlow(events: RepositoryContext[]): string[] {
  const flow: string[] = [];
  for (const event of events) {
    if (flow.at(-1) !== event.status) flow.push(event.status);
  }
  return flow;
}

function ready(overrides: Partial<RepositoryContext> = {}): RepositoryContext {
  return {
    repositoryId: 'r1',
    status: 'ready',
    content: 'last good',
    sourceRevision: evidence.sourceRevision,
    timestamps: {
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      generationStartedAt: '2026-08-01T00:00:10.000Z',
      generatedAt: '2026-08-01T00:01:00.000Z',
    },
    steps: [],
    failure: null,
    ...overrides,
  };
}

function harness(options: {
  initial?: RepositoryContext[];
  repositories?: Repository[];
  revision?: string;
  revisionError?: Error;
  revisionResult?: Promise<string>;
} = {}) {
  const contexts = new Map(
    (options.initial ?? []).map((context) => [context.repositoryId, context]),
  );
  const repositories = options.repositories ?? [repository];
  const generation = deferred<{ content: string }>();
  const collected: string[] = [];
  const generated: string[] = [];
  const deleted: string[] = [];
  const events: RepositoryContext[] = [];
  let revisionCalls = 0;
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  const repos: RepoService = {
    create: () => repository,
    get: (id) => {
      const found = repositories.find((item) => item.id === id);
      if (!found) {
        const error = new Error(`Unknown repository: ${id}`) as Error & {
          kind: string;
        };
        error.kind = 'not_found';
        throw error;
      }
      return found;
    },
    list: () => repositories,
    remove: () => undefined,
  };
  const bus = createEventBus<RepositoryContextEventMap>();
  bus.on('repository.context.updated', (context) => events.push(context));
  const coordinator = createRepositoryContextCoordinator({
    repositories: repos,
    contexts: {
      get: (id) => contexts.get(id) ?? null,
      list: () => [...contexts.values()],
      save: (context) => contexts.set(context.repositoryId, context),
      delete: (id) => {
        deleted.push(id);
        contexts.delete(id);
      },
    },
    revisions: {
      getRevision: async () => {
        revisionCalls += 1;
        if (options.revisionError) throw options.revisionError;
        if (options.revisionResult) return options.revisionResult;
        return options.revision ?? evidence.sourceRevision;
      },
    },
    evidence: {
      collect: async (path) => {
        collected.push(path);
        return evidence;
      },
    },
    generator: {
      generate: async (request) => {
        generated.push(request.repositoryPath);
        return generation.promise;
      },
    },
    clock: createClock(() => now++),
    bus,
  });
  return {
    coordinator,
    contexts,
    generation,
    collected,
    generated,
    deleted,
    events,
    revisionCalls: () => revisionCalls,
  };
}

describe('repository-context-coordinator', () => {
  it('initializes once, deduplicates concurrent work, and becomes ready', async () => {
    const h = harness();
    expect(h.coordinator.initialize('r1').status).toBe('pending');
    expect(h.coordinator.initialize('r1').status).toBe('generating');
    expect(h.collected).toEqual(['C:\\work\\app']);
    expect(h.generated).toHaveLength(0);

    h.generation.resolve({ content: 'generated context' });
    await settle();

    expect(h.generated).toEqual(['C:\\work\\app']);
    expect(h.coordinator.get('r1')).toMatchObject({
      status: 'ready',
      content: 'generated context',
      sourceRevision: evidence.sourceRevision,
      failure: null,
    });
    expect(statusFlow(h.events)).toEqual([
      'pending',
      'generating',
      'ready',
    ]);
  });

  it('rejects a concurrent manual refresh with a typed conflict', () => {
    const h = harness({ initial: [ready()] });
    expect(h.coordinator.refresh('r1').status).toBe('generating');
    expect(() => h.coordinator.refresh('r1')).toThrow(
      'generation is already running',
    );
    try {
      h.coordinator.refresh('r1');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'conflict' });
    }
  });

  it('creates pending state when manually refreshed before initialization', () => {
    const h = harness();
    expect(h.coordinator.refresh('r1').status).toBe('generating');
    expect(statusFlow(h.events)).toEqual([
      'pending',
      'generating',
    ]);
  });

  it('preserves last-good content and revision when generation fails', async () => {
    const h = harness({ initial: [ready()] });
    h.coordinator.refresh('r1');
    h.generation.reject(new Error('provider unavailable'));
    await settle();

    expect(h.coordinator.get('r1')).toMatchObject({
      status: 'failed',
      content: 'last good',
      sourceRevision: evidence.sourceRevision,
      failure: {
        code: 'generation_failed',
        message: 'provider unavailable',
        retryable: true,
      },
    });
  });

  it('uses a safe message for non-Error generation failures', async () => {
    const h = harness();
    h.coordinator.initialize('r1');
    h.generation.reject('bad');
    await settle();
    expect(h.coordinator.get('r1').failure?.message).toBe(
      'Repository analysis failed',
    );
  });

  it('returns typed not-found errors for unknown repositories and missing contexts', () => {
    const h = harness();
    expect(() => h.coordinator.get('missing')).toThrow('Unknown repository');
    try {
      h.coordinator.get('r1');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'not_found' });
    }
  });

  it('marks changed saved context stale and enqueues regeneration', async () => {
    const h = harness({
      initial: [ready()],
      revision: 'b'.repeat(40),
    });

    await h.coordinator.synchronizeSaved();
    expect(statusFlow(h.events)).toEqual(['stale', 'generating']);
    expect(h.contexts.get('r1')).toMatchObject({
      status: 'generating',
      content: 'last good',
    });
    expect(h.collected).toEqual(['C:\\work\\app']);
  });

  it('keeps an unchanged ready context launch-safe without regeneration', async () => {
    const h = harness({ initial: [ready()] });

    await expect(h.coordinator.ensureFresh('r1')).resolves.toMatchObject({
      status: 'ready',
      sourceRevision: evidence.sourceRevision,
    });
    expect(h.revisionCalls()).toBe(1);
    expect(h.events).toEqual([]);
    expect(h.collected).toEqual([]);
  });

  it('deduplicates concurrent runtime freshness checks and generation enqueue', async () => {
    const revision = deferred<string>();
    const h = harness({
      initial: [ready()],
      revisionResult: revision.promise,
    });

    const first = h.coordinator.ensureFresh('r1');
    const second = h.coordinator.ensureFresh('r1');
    expect(first).toBe(second);
    expect(h.revisionCalls()).toBe(1);

    revision.resolve('b'.repeat(40));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe('generating');
    expect(secondResult).toBe(firstResult);
    expect(statusFlow(h.events)).toEqual(['stale', 'generating']);
    expect(h.collected).toEqual(['C:\\work\\app']);
  });

  it('checks freshness when repository context is loaded', async () => {
    const h = harness({
      initial: [ready()],
      revision: 'b'.repeat(40),
    });

    await expect(h.coordinator.load('r1')).resolves.toMatchObject({
      status: 'generating',
    });
    expect(h.revisionCalls()).toBe(1);
    expect(statusFlow(h.events)).toEqual(['stale', 'generating']);
  });

  it('does not duplicate generation when startup synchronization overlaps a job', async () => {
    const h = harness();
    h.coordinator.initialize('r1');
    await h.coordinator.synchronizeSaved();
    expect(h.collected).toEqual(['C:\\work\\app']);
    expect(statusFlow(h.events)).toEqual([
      'pending',
      'generating',
    ]);
  });

  it('creates missing saved context and resumes interrupted lifecycle states', async () => {
    const second = { ...repository, id: 'r2', localPath: 'C:\\work\\other' };
    const h = harness({
      repositories: [repository, second],
      initial: [
        ready({
          repositoryId: 'r2',
          status: 'pending',
          content: null,
          sourceRevision: evidence.sourceRevision,
        }),
      ],
    });
    await h.coordinator.synchronizeSaved();
    expect(h.contexts.get('r1')?.status).toBe('generating');
    expect(h.contexts.get('r2')?.status).toBe('generating');
  });

  it('leaves ready and failed same-revision contexts unchanged', async () => {
    const second = { ...repository, id: 'r2' };
    const failed = ready({
      repositoryId: 'r2',
      status: 'failed',
      failure: {
        code: 'generation_failed',
        message: 'failed',
        failedAt: '2026-08-01T00:02:00.000Z',
        retryable: true,
        step: 'analyze',
      },
    });
    const h = harness({
      repositories: [repository, second],
      initial: [ready(), failed],
    });
    await h.coordinator.synchronizeSaved();
    expect(h.events).toEqual([]);
  });

  it('records revision lookup failures without discarding last-good context', async () => {
    const h = harness({
      initial: [ready()],
      revisionError: new Error('not a checkout'),
    });
    await h.coordinator.synchronizeSaved();
    expect(h.contexts.get('r1')).toMatchObject({
      status: 'failed',
      content: 'last good',
      failure: {
        code: 'revision_lookup_failed',
        message: 'not a checkout',
      },
    });
  });

  it('removes persisted context and suppresses completion of deleted work', async () => {
    const h = harness();
    h.coordinator.initialize('r1');
    h.coordinator.remove('r1');
    h.generation.resolve({ content: 'too late' });
    await settle();
    expect(h.deleted).toEqual(['r1']);
    expect(h.contexts.has('r1')).toBe(false);
    expect(h.events.at(-1)?.status).toBe('generating');

    const failed = harness();
    failed.coordinator.initialize('r1');
    failed.coordinator.remove('r1');
    failed.generation.reject(new Error('too late'));
    await settle();
    expect(failed.contexts.has('r1')).toBe(false);
  });

  it('tracks every pipeline step through to completion', async () => {
    const h = harness();
    h.coordinator.initialize('r1');
    h.generation.resolve({ content: 'generated context' });
    await settle();

    const context = h.coordinator.get('r1');
    expect(context.steps.map((step) => step.key)).toEqual([
      'collect-evidence',
      'analyze',
      'persist',
    ]);
    expect(context.steps.map((step) => step.status)).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
    expect(context.steps[0].detail).toContain('files');
    expect(context.failure).toBeNull();
  });

  it('surfaces the failing step and its provider detail', async () => {
    const h = harness({ initial: [ready()] });
    h.coordinator.refresh('r1');
    h.generation.reject(new Error('attachment file type not supported'));
    await settle();

    const context = h.coordinator.get('r1');
    expect(context.steps.map((step) => step.status)).toEqual([
      'ok',
      'failed',
      'skipped',
    ]);
    const analyze = context.steps.find((step) => step.key === 'analyze');
    expect(analyze?.detail).toBe('attachment file type not supported');
    expect(context.failure).toMatchObject({
      code: 'generation_failed',
      step: 'analyze',
      message: 'attachment file type not supported',
    });
  });

  it('publishes step transitions live during generation', async () => {
    const h = harness();
    h.coordinator.initialize('r1');
    h.generation.resolve({ content: 'ready summary' });
    await settle();

    const analyzeRunning = h.events.some((event) =>
      event.steps.some(
        (step) => step.key === 'analyze' && step.status === 'running',
      ),
    );
    expect(analyzeRunning).toBe(true);
  });
});
