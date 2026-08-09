import { describe, expect, it } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import type {
  PrReview,
  PrReviewRepo,
  PrReviewStepStatus,
} from './pr-review-contract.js';
import {
  INTERRUPTED_STEP_MESSAGE,
  createPrReviewReconciler,
} from './pr-review-reconciler.js';

function fixedClock(iso: string): Clock {
  const at = () => new Date(iso);
  return { now: at, isoNow: () => iso };
}

function step(status: PrReviewStepStatus) {
  return {
    status,
    metaSessionId: status === 'generating' ? 'meta-live' : null,
    usage: null,
    failure:
      status === 'failed'
        ? { message: 'boom', failedAt: '2026-08-01T00:00:00.000Z' }
        : null,
    activity: status === 'generating' ? ['💬 working'] : [],
    generatedAt: status === 'ready' ? '2026-08-01T00:00:00.000Z' : null,
  };
}

function review(
  overrides: {
    featureId?: string;
    problem?: PrReviewStepStatus;
    graph?: PrReviewStepStatus;
  } = {},
): PrReview {
  return {
    featureId: overrides.featureId ?? 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
    worktreePath: 'C:\\work\\pr-7',
    baseBranch: 'main',
    description: 'Requests fail transiently.',
    problemStatement: {
      ...step(overrides.problem ?? 'generating'),
      content: null,
      sufficient: true,
    },
    changeGraph: {
      ...step(overrides.graph ?? 'generating'),
      projects: [{ id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' }],
      nodes: [],
      edges: [],
    },
    changedFiles: null,
    timestamps: {
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
    },
  };
}

function memoryRepo(seed: PrReview[]): PrReviewRepo & { rows: Map<string, PrReview> } {
  const rows = new Map<string, PrReview>(seed.map((r) => [r.featureId, r]));
  return {
    rows,
    get: (id) => rows.get(id) ?? null,
    listAll: () => [...rows.values()],
    findFeatureByPull: () => null,
    save: (r) => {
      rows.set(r.featureId, r);
    },
    delete: (id) => {
      rows.delete(id);
    },
  };
}

const NOW = '2026-08-02T09:00:00.000Z';

describe('pr-review-reconciler', () => {
  it('fails only the orphaned (non-terminal) steps and preserves the rest', () => {
    const repo = memoryRepo([review({ problem: 'generating', graph: 'ready' })]);

    const count = createPrReviewReconciler({
      reviews: repo,
      clock: fixedClock(NOW),
    }).reconcileOrphans();

    expect(count).toBe(1);
    const saved = repo.get('f1')!;
    expect(saved.problemStatement.status).toBe('failed');
    expect(saved.problemStatement.failure).toEqual({
      message: INTERRUPTED_STEP_MESSAGE,
      failedAt: NOW,
    });
    // Type-specific fields survive the reset.
    expect(saved.problemStatement.sufficient).toBe(true);
    // The already-ready step is untouched.
    expect(saved.changeGraph.status).toBe('ready');
    expect(saved.changeGraph.projects).toHaveLength(1);
    expect(saved.timestamps.updatedAt).toBe(NOW);
  });

  it('fails a pending step left queued by a previous run', () => {    const repo = memoryRepo([review({ problem: 'pending', graph: 'pending' })]);

    const count = createPrReviewReconciler({
      reviews: repo,
      clock: fixedClock(NOW),
    }).reconcileOrphans();

    expect(count).toBe(1);
    const saved = repo.get('f1')!;
    expect(saved.problemStatement.status).toBe('failed');
    expect(saved.changeGraph.status).toBe('failed');
  });

  it('fails only the change-graph step when the problem statement is already ready', () => {
    const repo = memoryRepo([review({ problem: 'ready', graph: 'generating' })]);

    const count = createPrReviewReconciler({
      reviews: repo,
      clock: fixedClock(NOW),
    }).reconcileOrphans();

    expect(count).toBe(1);
    const saved = repo.get('f1')!;
    expect(saved.problemStatement.status).toBe('ready');
    expect(saved.changeGraph.status).toBe('failed');
    expect(saved.changeGraph.failure).toEqual({
      message: INTERRUPTED_STEP_MESSAGE,
      failedAt: NOW,
    });
  });

  it('leaves fully-settled reviews untouched and reports zero', () => {
    const repo = memoryRepo([
      review({ featureId: 'ready', problem: 'ready', graph: 'ready' }),
      review({ featureId: 'failed', problem: 'ready', graph: 'failed' }),
    ]);

    const count = createPrReviewReconciler({
      reviews: repo,
      clock: fixedClock(NOW),
    }).reconcileOrphans();

    expect(count).toBe(0);
    expect(repo.get('ready')!.timestamps.updatedAt).toBe(
      '2026-08-01T00:01:00.000Z',
    );
    expect(repo.get('failed')!.changeGraph.failure?.message).toBe('boom');
  });
});
