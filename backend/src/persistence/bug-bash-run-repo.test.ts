import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createBugBashRunRepo } from './bug-bash-run-repo.js';
import type {
  BugBashRun,
  BugBashScenario,
} from '../bug-bash/bug-bash-contract.js';

function scenario(overrides: Partial<BugBashScenario> = {}): BugBashScenario {
  return {
    id: 'scenario-1',
    title: 'Empty input',
    input: '""',
    steps: ['run it'],
    expectedOutput: 'an error',
    confirmation: '',
    status: 'pending',
    observations: '',
    ran: false,
    actualOutput: '',
    blockedReason: null,
    testerId: null,
    diagnostics: '',
    reproScript: '',
    evidenceGaps: [],
    ...overrides,
  };
}

function run(overrides: Partial<BugBashRun> = {}): BugBashRun {
  return {
    id: 'a1',
    featureId: 'f1',
    featureInfo: 'a feature',
    setupInfo: 'setup here',
    otherInfo: '',
    prerequisites: [],
    scenarios: [],
    report: null,
    status: 'draft',
    error: null,
    agents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function repo() {
  const db = createDatabase({ databasePath: ':memory:' });
  return { db, repo: createBugBashRunRepo(db) };
}

describe('bug-bash-run-repo', () => {
  it('creates and reads back a run', () => {
    const { db, repo: r } = repo();
    r.create(run());
    expect(r.get('a1')).toEqual(run());
    expect(r.get('missing')).toBeNull();
    db.close();
  });

  it('updates every mutable field of a run', () => {
    const { db, repo: r } = repo();
    r.create(run());
    const updated = run({
      featureInfo: 'new feature',
      setupInfo: 'new setup',
      scenarios: [scenario({ status: 'pass', observations: 'ok' })],
      report: '## Summary\nAll good.',
      status: 'reported',
      error: null,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    r.update(updated);
    expect(r.get('a1')).toEqual(updated);
    db.close();
  });

  it('persists and reads back a non-empty agent roster', () => {
    const { db, repo: r } = repo();
    const agents = [
      {
        id: 'lead',
        parentId: null,
        role: 'lead' as const,
        title: 'Lead agent',
        scenarioIds: [],
        status: 'done' as const,
        startedAt: null,
        durationMs: 12,
        inputTokens: 3,
        outputTokens: 4,
        credits: null,
      },
    ];
    r.create(run({ agents }));
    expect(r.get('a1')!.agents).toEqual(agents);
    db.close();
  });

  it('tolerates null, corrupt and non-array json columns', () => {
    const { db, repo: r } = repo();
    r.create(run({ id: 'n' }));
    r.create(run({ id: 'c' }));
    r.create(run({ id: 'o' }));
    db.exec("UPDATE bug_bash_runs SET agents = NULL, scenarios = NULL WHERE id = 'n'");
    db.exec("UPDATE bug_bash_runs SET agents = 'x', scenarios = 'x' WHERE id = 'c'");
    db.exec("UPDATE bug_bash_runs SET agents = '{\"a\":1}', scenarios = '{\"a\":1}' WHERE id = 'o'");
    expect(r.get('n')!.agents).toEqual([]);
    expect(r.get('n')!.scenarios).toEqual([]);
    expect(r.get('c')!.agents).toEqual([]);
    expect(r.get('c')!.scenarios).toEqual([]);
    expect(r.get('o')!.agents).toEqual([]);
    expect(r.get('o')!.scenarios).toEqual([]);
    db.close();
  });

  it('defaults missing json arrays to empty on write', () => {
    const { db, repo: r } = repo();
    r.create(
      run({
        agents: undefined as unknown as BugBashRun['agents'],
        scenarios: undefined as unknown as BugBashRun['scenarios'],
        otherInfo: undefined as unknown as BugBashRun['otherInfo'],
        prerequisites: undefined as unknown as BugBashRun['prerequisites'],
      }),
    );
    expect(r.get('a1')!.agents).toEqual([]);
    expect(r.get('a1')!.otherInfo).toBe('');
    expect(r.get('a1')!.prerequisites).toEqual([]);
    r.update(
      run({
        agents: undefined as unknown as BugBashRun['agents'],
        scenarios: undefined as unknown as BugBashRun['scenarios'],
        otherInfo: undefined as unknown as BugBashRun['otherInfo'],
        prerequisites: undefined as unknown as BugBashRun['prerequisites'],
      }),
    );
    expect(r.get('a1')!.scenarios).toEqual([]);
    db.close();
  });

  it('backfills scenario fields missing from a legacy persisted run', () => {
    const { db, repo: r } = repo();
    r.create(run({ id: 'legacy' }));
    // A run persisted before reproScript/evidenceGaps existed.
    const legacyScenario = JSON.stringify([
      {
        id: 'scenario-1',
        title: 'Old',
        input: '',
        steps: [],
        expectedOutput: '',
        confirmation: '',
        status: 'pass',
        observations: 'ok',
        ran: true,
        actualOutput: 'ran',
        blockedReason: null,
        testerId: 'tester-1',
        diagnostics: 'log',
      },
    ]).replace(/'/g, "''");
    db.exec(
      `UPDATE bug_bash_runs SET scenarios = '${legacyScenario}' WHERE id = 'legacy'`,
    );
    const [loaded] = r.get('legacy')!.scenarios;
    expect(loaded.reproScript).toBe('');
    expect(loaded.evidenceGaps).toEqual([]);
    db.close();
  });

  it('round-trips other info and prerequisite questions', () => {
    const { db, repo: r } = repo();
    r.create(
      run({
        otherInfo: 'extra notes',
        prerequisites: [
          {
            id: 'prereq-1',
            question: 'Which account?',
            detail: 'to connect',
            options: ['Shared', 'Personal'],
            answer: 'acct-1',
          },
        ],
      }),
    );
    const loaded = r.get('a1')!;
    expect(loaded.otherInfo).toBe('extra notes');
    expect(loaded.prerequisites).toEqual([
      {
        id: 'prereq-1',
        question: 'Which account?',
        detail: 'to connect',
        options: ['Shared', 'Personal'],
        answer: 'acct-1',
      },
    ]);
    db.close();
  });

  it('backfills options missing from a legacy persisted prerequisite', () => {
    const { db, repo: r } = repo();
    r.create(run({ id: 'legacy' }));
    const legacyPrereq = JSON.stringify([
      { id: 'prereq-1', question: 'Q?', detail: '', answer: '' },
    ]).replace(/'/g, "''");
    db.exec(
      `UPDATE bug_bash_runs SET prerequisites = '${legacyPrereq}' WHERE id = 'legacy'`,
    );
    expect(r.get('legacy')!.prerequisites[0].options).toEqual([]);
    db.close();
  });

  it('backfills prerequisites missing from a legacy persisted run', () => {
    const { db, repo: r } = repo();
    r.create(run({ id: 'legacy' }));
    db.exec(
      "UPDATE bug_bash_runs SET prerequisites = NULL WHERE id = 'legacy'",
    );
    const loaded = r.get('legacy')!;
    expect(loaded.otherInfo).toBe('');
    expect(loaded.prerequisites).toEqual([]);
    db.close();
  });

  it('deletes a run by id', () => {
    const { db, repo: r } = repo();
    r.create(run());
    r.delete('a1');
    expect(r.get('a1')).toBeNull();
    db.close();
  });

  it('deletes all runs for a feature', () => {
    const { db, repo: r } = repo();
    r.create(run({ id: 'a1', featureId: 'f1' }));
    r.create(run({ id: 'a2', featureId: 'f1' }));
    r.create(run({ id: 'b1', featureId: 'f2' }));
    r.deleteByFeature('f1');
    expect(r.get('a1')).toBeNull();
    expect(r.get('a2')).toBeNull();
    expect(r.get('b1')).not.toBeNull();
    db.close();
  });
});
