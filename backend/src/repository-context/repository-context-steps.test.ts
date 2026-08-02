import { describe, expect, it } from 'vitest';
import { createClock } from '../kernel/clock.js';
import type { RepositoryContextStep } from './repository-context-contract.js';
import {
  REPOSITORY_CONTEXT_STEPS,
  createRepositoryContextStepTracker,
  initialRepositoryContextSteps,
} from './repository-context-steps.js';

function tracker() {
  const snapshots: RepositoryContextStep[][] = [];
  let tick = 0;
  const instance = createRepositoryContextStepTracker({
    clock: createClock(() => tick++),
    onChange: (steps) => snapshots.push(steps),
  });
  return { instance, snapshots };
}

describe('repository-context-steps', () => {
  it('builds an all-pending step list from the pipeline definition', () => {
    const steps = initialRepositoryContextSteps();
    expect(steps).toHaveLength(REPOSITORY_CONTEXT_STEPS.length);
    expect(steps.every((step) => step.status === 'pending')).toBe(true);
    expect(steps.map((step) => step.key)).toEqual(
      REPOSITORY_CONTEXT_STEPS.map((step) => step.key),
    );
  });

  it('records running, progress detail, and completion for each step', async () => {
    const { instance, snapshots } = tracker();

    const evidence = await instance.run('collect-evidence', async (report) => {
      report('42 files');
      return 'evidence';
    });
    const result = await instance.run('analyze', async () => 'analysis');
    await instance.run('persist', async () => undefined);

    expect(evidence).toBe('evidence');
    expect(result).toBe('analysis');
    expect(instance.failedStep()).toBeNull();
    expect(instance.failedStepKey()).toBeNull();

    const final = instance.snapshot();
    expect(final.map((step) => step.status)).toEqual(['ok', 'ok', 'ok']);
    const collect = final[0];
    expect(collect.detail).toBe('42 files');
    expect(collect.startedAt).not.toBeNull();
    expect(collect.finishedAt).not.toBeNull();

    // running, progress, ok for collect; running, ok for analyze; running, ok for persist
    const runningSnapshots = snapshots.filter((snapshot) =>
      snapshot.some((step) => step.status === 'running'),
    );
    expect(runningSnapshots.length).toBeGreaterThan(0);
  });

  it('marks the failing step failed, skips later steps, and rethrows', async () => {
    const { instance } = tracker();
    await instance.run('collect-evidence', async () => 'ok');

    await expect(
      instance.run('analyze', async () => {
        throw new Error('attachment not supported');
      }),
    ).rejects.toThrow('attachment not supported');

    const failed = instance.failedStep();
    expect(failed?.key).toBe('analyze');
    expect(failed?.detail).toBe('attachment not supported');
    expect(instance.failedStepKey()).toBe('analyze');

    const steps = instance.snapshot();
    expect(steps.map((step) => step.status)).toEqual(['ok', 'failed', 'skipped']);
  });

  it('uses a safe detail for non-Error and empty-message failures', async () => {
    const { instance } = tracker();
    await expect(
      instance.run('collect-evidence', async () => {
        throw 'raw string';
      }),
    ).rejects.toBe('raw string');
    expect(instance.failedStep()?.detail).toBe('Repository analysis failed');

    const blank = tracker();
    await expect(
      blank.instance.run('collect-evidence', async () => {
        throw new Error('   ');
      }),
    ).rejects.toThrow();
    expect(blank.instance.failedStep()?.detail).toBe(
      'Repository analysis failed',
    );
  });
});
