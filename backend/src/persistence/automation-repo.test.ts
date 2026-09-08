import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createAutomationRepo } from './automation-repo.js';
import type {
  Automation,
  AutomationRun,
} from '../automation/automation-contract.js';

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Watch CI',
    mode: 'long',
    status: 'active',
    origin: { sessionId: 's1', featureId: 'f1' },
    check: { type: 'shell', command: 'echo hi' },
    condition: { type: 'exit-code', equals: 0 },
    action: { type: 'report', prompt: 'summarize' },
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
    phase: 'finished',
    scheduledForAt: null,
    occurrenceKey: null,
    dedupeKey: 'scheduled:a1',
    startedAt: '2026-01-01T00:00:01.000Z',
    dispatchedAt: '2026-01-01T00:00:01.000Z',
    endedAt: '2026-01-01T00:00:02.000Z',
    triggered: true,
    status: 'ok',
    detail: 'ran',
    sessionId: 'meta-1',
    report: null,
    ...overrides,
  };
}

describe('automation-repo', () => {
  it('creates, reads and lists automations ordered by created_at', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    repo.create(
      automation({ id: 'a2', createdAt: '2026-01-02T00:00:00.000Z' }),
    );
    repo.create(automation({ id: 'a1' }));

    expect(repo.get('a1')).toEqual(automation({ id: 'a1' }));
    expect(repo.get('missing')).toBeNull();
    expect(repo.list().map((a) => a.id)).toEqual(['a1', 'a2']);
    db.close();
  });

  it('round-trips full spec fields including planned steps and max runs', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    const full = automation({
      id: 'full',
      mode: 'short',
      status: 'completed',
      origin: { sessionId: null, featureId: null },
      check: { type: 'ci-pipeline', provider: 'github', repo: 'o/r' },
      condition: { type: 'ai-verdict' },
      action: { type: 'subagent', task: 'analyze', prompt: 'go' },
      maxRuns: 3,
      runCount: 2,
      progress: 'working',
      plannedSteps: [
        { id: 'p1', label: 'Detect', status: 'done', detail: 'done' },
        { id: 'p2', label: 'Report', status: 'pending', detail: null },
      ],
      lastOccurrenceKey: 'run-42',
      lastCheckedAt: '2026-01-01T00:05:00.000Z',
      nextRunAt: '2026-01-01T00:06:00.000Z',
      failure: 'boom',
    });
    repo.create(full);

    expect(repo.get('full')).toEqual(full);
    db.close();
  });

  it('updates an automation via save', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    repo.create(automation({ id: 'a1' }));
    repo.save(
      automation({
        id: 'a1',
        status: 'paused',
        runCount: 5,
        progress: 'paused now',
      }),
    );

    const loaded = repo.get('a1');
    expect(loaded?.status).toBe('paused');
    expect(loaded?.runCount).toBe(5);
    expect(loaded?.progress).toBe('paused now');
    db.close();
  });

  it('appends and lists runs newest-first, and cascades delete', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    repo.create(automation({ id: 'a1' }));
    repo.appendRun(run({ id: 'r1', startedAt: '2026-01-01T00:00:01.000Z' }));
    repo.appendRun(
      run({
        id: 'r2',
        startedAt: '2026-01-01T00:00:03.000Z',
        triggered: false,
        status: 'skipped',
        detail: null,
        endedAt: null,
        sessionId: null,
      }),
    );

    const runs = repo.listRuns('a1');
    expect(runs.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(runs[0]?.triggered).toBe(false);
    expect(runs[1]?.triggered).toBe(true);
    expect(runs[1]?.report).toBeNull();

    repo.delete('a1');
    expect(repo.get('a1')).toBeNull();
    expect(repo.listRuns('a1')).toEqual([]);
    db.close();
  });

  it('loads, updates, and finds open runs with durable phase metadata', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    repo.create(automation({ id: 'a1' }));
    repo.appendRun(
      run({
        id: 'queued',
        source: 'manual',
        phase: 'queued',
        scheduledForAt: null,
        occurrenceKey: null,
        dedupeKey: 'manual:a1:r1',
        dispatchedAt: null,
        endedAt: null,
        status: 'skipped',
        detail: 'Queued to run now',
      }),
    );
    repo.appendRun(
      run({
        id: 'done',
        phase: 'finished',
        occurrenceKey: 'run-42',
        detail: 'Triggered · green',
      }),
    );

    expect(repo.getRun('queued')).toMatchObject({
      id: 'queued',
      source: 'manual',
      phase: 'queued',
      dedupeKey: 'manual:a1:r1',
      dispatchedAt: null,
      report: null,
      acknowledgedRunIds: null,
      acknowledgedSnapshotRunIds: null,
      resolvedByRunId: null,
    });
    expect(repo.findOpenRun('a1')?.id).toBe('queued');
    expect(repo.listOpenRuns().map((item) => item.id)).toEqual(['queued']);

    repo.saveRun({
      ...repo.getRun('queued')!,
      phase: 'finished',
      triggered: true,
      status: 'ok',
      occurrenceKey: 'manual-1',
      dispatchedAt: '2026-01-01T00:00:01.500Z',
      endedAt: '2026-01-01T00:00:02.000Z',
      detail: 'done',
      report: 'saved report',
    });

    expect(repo.findOpenRun('a1')).toBeNull();
    expect(repo.getRun('queued')).toMatchObject({
      phase: 'finished',
      occurrenceKey: 'manual-1',
      status: 'ok',
      report: 'saved report',
    });
    db.close();
  });

  it('lists only unresolved uncertain runs and round-trips retry metadata', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    repo.create(automation({ id: 'a1' }));
    repo.appendRun(
      run({
        id: 'uncertain-a',
        phase: 'uncertain',
        occurrenceKey: 'occurrence-a',
        status: 'failed',
        acknowledgedRunIds: ['uncertain-a'],
        acknowledgedSnapshotRunIds: ['uncertain-a', 'uncertain-b'],
      }),
    );
    repo.appendRun(
      run({
        id: 'uncertain-b',
        phase: 'uncertain',
        occurrenceKey: null,
        status: 'failed',
        startedAt: '2026-01-01T00:00:03.000Z',
        acknowledgedRunIds: ['uncertain-b'],
        acknowledgedSnapshotRunIds: ['uncertain-a', 'uncertain-b'],
      }),
    );
    repo.appendRun(
      run({
        id: 'resolved-success',
        phase: 'finished',
        occurrenceKey: 'occurrence-a',
        startedAt: '2026-01-01T00:00:04.000Z',
        dispatchedAt: '2026-01-01T00:00:04.000Z',
        endedAt: '2026-01-01T00:00:05.000Z',
        detail: 'done',
      }),
    );
    repo.saveRun({
      ...repo.getRun('uncertain-b')!,
      resolvedByRunId: 'manual-retry',
    });

    expect(repo.listPendingUncertainRuns('a1')).toEqual([]);
    expect(repo.getRun('uncertain-a')).toMatchObject({
      acknowledgedRunIds: ['uncertain-a'],
      acknowledgedSnapshotRunIds: ['uncertain-a', 'uncertain-b'],
    });
    expect(repo.getRun('uncertain-b')).toMatchObject({
      resolvedByRunId: 'manual-retry',
    });
    db.close();
  });

  it('rolls back failed transactions without leaving partial automation or run writes', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    repo.create(automation({ id: 'a1' }));
    expect(() =>
      repo.transact(() => {
        repo.save(automation({ id: 'a1', progress: 'queued' }));
        repo.appendRun(run({ id: 'r-rollback', phase: 'queued', endedAt: null }));
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(repo.get('a1')?.progress).toBeNull();
    expect(repo.getRun('r-rollback')).toBeNull();
    db.close();
  });

  it('supports nested transactions with savepoints for success and rollback', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createAutomationRepo(db);

    repo.create(automation({ id: 'a1' }));
    repo.transact(() => {
      repo.save(automation({ id: 'a1', progress: 'outer' }));
      repo.transact(() => {
        repo.save(automation({ id: 'a1', progress: 'inner' }));
        repo.appendRun(
          run({
            id: 'r-inner',
            phase: 'queued',
            dispatchedAt: null,
            endedAt: null,
            detail: 'Queued to check',
          }),
        );
      });
      expect(repo.get('a1')?.progress).toBe('inner');
      expect(repo.getRun('r-inner')).not.toBeNull();
      expect(() =>
        repo.transact(() => {
          repo.save(automation({ id: 'a1', progress: 'inner-fail' }));
          repo.appendRun(run({ id: 'r-fail' }));
          throw new Error('nested boom');
        }),
      ).toThrow('nested boom');
      expect(repo.get('a1')?.progress).toBe('inner');
      expect(repo.getRun('r-fail')).toBeNull();
    });

    expect(repo.get('a1')?.progress).toBe('inner');
    expect(repo.getRun('r-inner')).toMatchObject({ phase: 'queued' });
    db.close();
  });
});
