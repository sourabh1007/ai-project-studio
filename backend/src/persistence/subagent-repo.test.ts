import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createSubagentRepo } from './subagent-repo.js';
import type { Subagent } from '../automation/automation-contract.js';

function subagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 'g1',
    automationId: 'a1',
    origin: { sessionId: 's1', featureId: 'f1' },
    task: 'Analyze failures',
    status: 'running',
    progress: null,
    result: null,
    sessionId: 'meta-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('subagent-repo', () => {
  it('creates, reads and lists subagents ordered by created_at', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSubagentRepo(db);

    repo.create(subagent({ id: 'g2', createdAt: '2026-01-02T00:00:00.000Z' }));
    repo.create(subagent({ id: 'g1' }));

    expect(repo.get('g1')).toEqual(subagent({ id: 'g1' }));
    expect(repo.get('missing')).toBeNull();
    expect(repo.list().map((s) => s.id)).toEqual(['g1', 'g2']);
    db.close();
  });

  it('round-trips a detached subagent with progress and result', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSubagentRepo(db);

    const detached = subagent({
      id: 'g9',
      automationId: null,
      origin: { sessionId: null, featureId: null },
      status: 'done',
      progress: 'step 2',
      result: 'all good',
      sessionId: null,
    });
    repo.create(detached);

    expect(repo.get('g9')).toEqual(detached);
    db.close();
  });

  it('updates a subagent via save', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSubagentRepo(db);

    repo.create(subagent({ id: 'g1' }));
    repo.save(
      subagent({ id: 'g1', status: 'done', progress: 'finished', result: 'ok' }),
    );

    const loaded = repo.get('g1');
    expect(loaded?.status).toBe('done');
    expect(loaded?.result).toBe('ok');
    db.close();
  });

  it('lists subagents by automation id', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createSubagentRepo(db);

    repo.create(subagent({ id: 'g1', automationId: 'a1' }));
    repo.create(subagent({ id: 'g2', automationId: 'a2' }));
    repo.create(subagent({ id: 'g3', automationId: 'a1' }));

    expect(repo.listByAutomation('a1').map((s) => s.id)).toEqual(['g1', 'g3']);
    expect(repo.listByAutomation('none')).toEqual([]);
    db.close();
  });
});
