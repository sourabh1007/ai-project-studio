import { describe, expect, it, vi } from 'vitest';
import type { PlannerTask } from '../planner/planner-contract.js';
import { plannerSummaryDefaults } from './config.js';
import { createPlannerSummaryRunner } from './planner-summary-runner.js';

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
  tasks?: PlannerTask[];
  run?: ReturnType<typeof vi.fn>;
}) {
  const run = options.run ?? vi.fn(async () => 'A concise summary.');
  const runner = createPlannerSummaryRunner({
    planner: { list: () => options.tasks ?? [] },
    meta: { run },
    clock: { isoNow: () => '2026-02-11T00:00:00.000Z' } as never,
    config: plannerSummaryDefaults,
  });
  return { runner, run };
}

describe('createPlannerSummaryRunner', () => {
  it('attributes the run to the synthetic host feature id and returns the summary', async () => {
    const { runner, run } = makeRunner({
      tasks: [task({ title: 'Do work' })],
    });
    const result = await runner.summarize({
      scope: 'day',
      date: '2026-02-10',
      prompt: 'overview',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: plannerSummaryDefaults.hostFeatureId,
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
