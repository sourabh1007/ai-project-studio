import { describe, expect, it } from 'vitest';
import type { Automation, AutomationRun } from './automation-contract.js';
import {
  decorateAutomationWithUncertainty,
  pendingUncertainRuns,
  summarizeAutomationUncertainty,
} from './automation-uncertainty.js';

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Watch CI',
    mode: 'long',
    status: 'active',
    origin: { sessionId: null, featureId: null },
    check: { type: 'shell', command: 'echo hi' },
    condition: { type: 'status-equals', value: 'completed' },
    action: { type: 'report', prompt: 'go' },
    intervalMs: 60_000,
    maxRuns: null,
    runCount: 0,
    progress: null,
    plannedSteps: [],
    lastOccurrenceKey: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastCheckedAt: null,
    nextRunAt: null,
    failure: null,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1',
    automationId: 'a1',
    source: 'scheduled',
    phase: 'uncertain',
    scheduledForAt: null,
    occurrenceKey: 'run-1',
    dedupeKey: 'scheduled:a1:run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    dispatchedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    triggered: true,
    status: 'failed',
    detail:
      'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
    sessionId: null,
    acknowledgedRunIds: null,
    acknowledgedSnapshotRunIds: null,
    resolvedByRunId: null,
    ...overrides,
  };
}

describe('automation uncertainty helpers', () => {
  it('keeps only unresolved uncertain runs pending', () => {
    const runs = [
      run({ id: 'pending-known' }),
      run({ id: 'resolved-explicit', resolvedByRunId: 'retry-1' }),
      run({
        id: 'resolved-success',
        occurrenceKey: 'run-2',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
      run({
        id: 'later-success',
        phase: 'finished',
        status: 'ok',
        occurrenceKey: 'run-2',
        startedAt: '2026-01-01T00:00:02.000Z',
        endedAt: '2026-01-01T00:00:03.000Z',
        detail: 'done',
      }),
      run({
        id: 'not-triggered',
        triggered: false,
      }),
      run({
        id: 'finished-failed',
        phase: 'finished',
      }),
    ];

    expect(pendingUncertainRuns(runs).map((item) => item.id)).toEqual([
      'pending-known',
    ]);
  });

  it('summarizes unknown occurrence uncertainty as globally blocking', () => {
    expect(
      summarizeAutomationUncertainty([
        run({
          id: 'unknown',
          occurrenceKey: null,
          detail: null,
        }),
      ]),
    ).toEqual({
      summary:
        'A previous action may already have executed, and its occurrence identity is unknown. Automatic retries stay blocked until you explicitly confirm a retry.',
      unresolvedRunIds: ['unknown'],
    });
  });

  it('summarizes multiple known unresolved occurrences', () => {
    expect(
      summarizeAutomationUncertainty([
        run({ id: 'a', occurrenceKey: 'run-1' }),
        run({ id: 'b', occurrenceKey: 'run-2', startedAt: '2026-01-01T00:00:02.000Z' }),
      ]),
    ).toEqual({
      summary:
        'Previous actions may already have executed for 2 unresolved occurrences (run-1, run-2). Automatic retries stay blocked until you explicitly confirm a retry.',
      unresolvedRunIds: ['a', 'b'],
    });
  });

  it('falls back to a count-only summary when known occurrence labels are blank', () => {
    expect(
      summarizeAutomationUncertainty([
        run({ id: 'a', occurrenceKey: '' }),
        run({ id: 'b', occurrenceKey: '', startedAt: '2026-01-01T00:00:02.000Z' }),
      ]),
    ).toEqual({
      summary:
        'Previous actions may already have executed for 2 unresolved occurrences. Automatic retries stay blocked until you explicitly confirm a retry.',
      unresolvedRunIds: ['a', 'b'],
    });
  });

  it('adds and removes uncertainty decorations truthfully', () => {
    const base = automation({
      uncertainty: {
        summary: 'stale',
        unresolvedRunIds: ['old'],
      },
    });

    expect(
      decorateAutomationWithUncertainty(base, [run({ id: 'fresh' })]),
    ).toMatchObject({
      uncertainty: {
        unresolvedRunIds: ['fresh'],
      },
    });
    expect(decorateAutomationWithUncertainty(base, [])).not.toHaveProperty(
      'uncertainty',
    );
  });
});
