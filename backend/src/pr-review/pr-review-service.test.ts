import { describe, expect, it } from 'vitest';
import { createEventBus } from '../kernel/event-bus.js';
import type { Clock } from '../kernel/clock.js';
import type { RemotePullRequest } from '../repo/remote-pr-contract.js';
import { prReviewDefaults } from './config.js';
import type {
  PrDiff,
  PrDiffRequest,
  PrReview,
  PrReviewEventMap,
  PrReviewRepo,
  StartPrReviewInput,
} from './pr-review-contract.js';
import { createPrReviewService } from './pr-review-service.js';

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
};

const startInput: StartPrReviewInput = {
  featureId: 'f1',
  repoId: 'r1',
  pull,
  worktreePath: 'C:\\work\\pr-7',
  baseBranch: 'main',
};

const diff: PrDiff = {
  baseRef: 'origin/main',
  changedFiles: 4,
  stat: ' src/a.ts | 2 +-',
  patch: '@@ -1 +1 @@\n-old\n+new',
  truncated: false,
};

function harness(options: {
  aiText?: string;
  aiError?: Error;
  diffError?: Error;
  context?: string | null;
} = {}) {
  const reviews = memoryRepo();
  const bus = createEventBus<PrReviewEventMap>();
  const events: PrReview[] = [];
  bus.on('pr.review.updated', (review) => events.push(review));
  const diffRequests: PrDiffRequest[] = [];
  const service = createPrReviewService({
    reviews,
    bus,
    clock: stepClock(),
    config: prReviewDefaults,
    context: {
      readyContent: () =>
        options.context === undefined ? 'ready context' : options.context,
    },
    diffs: {
      collect: async (request) => {
        diffRequests.push(request);
        if (options.diffError) throw options.diffError;
        return diff;
      },
    },
    ai: {
      run: async () => {
        if (options.aiError) throw options.aiError;
        return (
          options.aiText ??
          '## PR Summary\nAdds retry.\n\n## Core Analysis\n- wraps client'
        );
      },
    },
  });
  return { service, reviews, events, diffRequests };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createPrReviewService', () => {
  it('starts generating then resolves to a ready review', async () => {
    const h = harness();
    const started = h.service.start(startInput);
    expect(started.status).toBe('generating');
    expect(h.diffRequests).toEqual([
      { worktreePath: 'C:\\work\\pr-7', baseBranch: 'main' },
    ]);

    await settle();

    const ready = h.service.get('f1');
    expect(ready.status).toBe('ready');
    expect(ready.summary).toBe('Adds retry.');
    expect(ready.coreAnalysis).toBe('- wraps client');
    expect(ready.changedFiles).toBe(4);
    expect(ready.timestamps.generatedAt).not.toBeNull();
    expect(h.events.map((e) => e.status)).toEqual(['generating', 'ready']);
  });

  it('marks the review failed when generation throws', async () => {
    const h = harness({ aiError: new Error('provider exited 1') });
    h.service.start(startInput);
    await settle();

    const failed = h.service.get('f1');
    expect(failed.status).toBe('failed');
    expect(failed.failure?.message).toBe('provider exited 1');
    expect(failed.summary).toBeNull();
  });

  it('fails when the model returns no usable content', async () => {
    const h = harness({ aiText: '   ' });
    h.service.start(startInput);
    await settle();

    const failed = h.service.get('f1');
    expect(failed.status).toBe('failed');
    expect(failed.failure?.message).toBe('PR review returned no content');
  });

  it('reports a generic message for non-Error failures', async () => {
    const reviews = memoryRepo();
    const bus = createEventBus<PrReviewEventMap>();
    const service = createPrReviewService({
      reviews,
      bus,
      clock: stepClock(),
      config: prReviewDefaults,
      context: { readyContent: () => null },
      diffs: {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        collect: async () => {
          throw 'boom';
        },
      },
      ai: { run: async () => 'x' },
    });
    service.start(startInput);
    await settle();
    expect(service.get('f1').failure?.message).toBe('PR review failed');
  });

  it('find returns null and get throws when no review exists', () => {
    const h = harness();
    expect(h.service.find('missing')).toBeNull();
    expect(() => h.service.get('missing')).toThrow(/not available/);
  });

  it('refresh re-runs an existing review and preserves createdAt', async () => {
    const h = harness();
    h.service.start(startInput);
    await settle();
    const first = h.service.get('f1');

    const refreshed = h.service.refresh('f1');
    expect(refreshed.status).toBe('generating');
    expect(refreshed.timestamps.createdAt).toBe(first.timestamps.createdAt);
    await settle();
    expect(h.service.get('f1').status).toBe('ready');
  });

  it('refresh rejects when no review exists', () => {
    const h = harness();
    expect(() => h.service.refresh('missing')).toThrow(/not available/);
  });

  it('refresh rejects while a generation is already in flight', () => {
    const h = harness();
    h.service.start(startInput);
    expect(() => h.service.refresh('f1')).toThrow(/already running/);
  });

  it('preserves the original createdAt when starting over an existing review', async () => {
    const h = harness();
    const seeded: PrReview = {
      featureId: 'f1',
      repoId: 'r1',
      pull: { number: 7, title: 'old', url: 'u' },
      worktreePath: 'C:\\work\\pr-7',
      baseBranch: 'main',
      status: 'failed',
      summary: null,
      coreAnalysis: null,
      changedFiles: null,
      timestamps: {
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        generatedAt: null,
      },
      failure: { message: 'old', failedAt: '2020-01-01T00:00:00.000Z' },
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
});
