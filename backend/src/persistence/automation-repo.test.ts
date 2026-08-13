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
    startedAt: '2026-01-01T00:00:01.000Z',
    endedAt: '2026-01-01T00:00:02.000Z',
    triggered: true,
    status: 'ok',
    detail: 'ran',
    sessionId: 'meta-1',
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

    repo.delete('a1');
    expect(repo.get('a1')).toBeNull();
    expect(repo.listRuns('a1')).toEqual([]);
    db.close();
  });
});
