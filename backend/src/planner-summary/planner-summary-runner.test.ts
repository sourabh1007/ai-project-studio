import { describe, expect, it, vi } from 'vitest';
import type { Feature } from '../feature/feature-contract.js';
import type { PlannerTask } from '../planner/planner-contract.js';
import { plannerSummaryDefaults } from './config.js';
import { createPlannerSummaryRunner } from './planner-summary-runner.js';

function feature(partial: Partial<Feature>): Feature {
  return {
    id: 'host-1',
    name: plannerSummaryDefaults.hostFeatureName,
    description: '',
    createdAt: '2026-02-10T00:00:00.000Z',
    summary: null,
    repoId: null,
    ...partial,
  };
}

function task(partial: Partial<PlannerTask>): PlannerTask {
  return {
    id: 'id',
    title: 'Task',
    notes: '',
    priority: 'p2',
    status: 'open',
    kind: 'task',
    prUrl: '',
    date: '2026-02-10',
    repoId: null,
    launchKind: null,
    featureId: null,
    sessionId: null,
    launchLabel: null,
    backloggedAt: null,
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-02-10T00:00:00.000Z',
    ...partial,
  };
}

function makeRunner(options: {
  features?: Feature[];
  tasks?: PlannerTask[];
  run?: ReturnType<typeof vi.fn>;
}) {
  const listFeatures = vi.fn(() => options.features ?? []);
  const createFeature = vi.fn((input: { name: string }) =>
    feature({ id: 'created-1', name: input.name }),
  );
  const run = options.run ?? vi.fn(async () => 'A concise summary.');
  const runner = createPlannerSummaryRunner({
    planner: { list: () => options.tasks ?? [] },
    features: { list: listFeatures, create: createFeature } as never,
    meta: { run },
    clock: { isoNow: () => '2026-02-11T00:00:00.000Z' } as never,
    config: plannerSummaryDefaults,
  });
  return { runner, listFeatures, createFeature, run };
}

describe('createPlannerSummaryRunner', () => {
  it('creates the host feature when none exists and returns the summary', async () => {
    const { runner, createFeature, run } = makeRunner({
      tasks: [task({ title: 'Do work' })],
    });
    const result = await runner.summarize({
      scope: 'day',
      date: '2026-02-10',
      prompt: 'overview',
    });
    expect(createFeature).toHaveBeenCalledWith({
      name: plannerSummaryDefaults.hostFeatureName,
      description: plannerSummaryDefaults.hostFeatureDescription,
      repoId: null,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'created-1',
        scope: 'internal',
        noTools: true,
        toolsOptional: true,
        purpose: 'planner-summary',
        label: 'Planner summary',
      }),
    );
    expect(result).toEqual({
      scope: 'day',
      date: '2026-02-10',
      range: '2026-02-10',
      content: 'A concise summary.',
      taskCount: 1,
      createdAt: '2026-02-11T00:00:00.000Z',
    });
  });

  it('reuses an existing internal host feature', async () => {
    const existing = feature({ id: 'host-99', repoId: null });
    const { runner, createFeature, run } = makeRunner({ features: [existing] });
    await runner.summarize({ scope: 'month', date: '2026-02-10', prompt: '' });
    expect(createFeature).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 'host-99' }),
    );
  });

  it('ignores repo-scoped features with the same name', async () => {
    const repoScoped = feature({ id: 'repo-feature', repoId: 'repo-1' });
    const { runner, createFeature } = makeRunner({ features: [repoScoped] });
    await runner.summarize({ scope: 'day', date: '2026-02-10', prompt: '' });
    expect(createFeature).toHaveBeenCalled();
  });

  it('substitutes the empty-summary placeholder when no text is produced', async () => {
    const { runner } = makeRunner({ run: vi.fn(async () => '   ') });
    const result = await runner.summarize({
      scope: 'year',
      date: '2026-02-10',
      prompt: '',
    });
    expect(result.content).toBe(plannerSummaryDefaults.emptySummaryPlaceholder);
  });

  it('aborts before running when the signal is already aborted', async () => {
    const run = vi.fn();
    const { runner } = makeRunner({ run });
    await expect(
      runner.summarize({
        scope: 'day',
        date: '2026-02-10',
        prompt: '',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
