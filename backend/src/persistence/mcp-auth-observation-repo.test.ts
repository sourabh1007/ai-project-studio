import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { applySchema } from './db/schema.js';
import { createMcpAuthObservationRepo } from './mcp-auth-observation-repo.js';
import type { McpAuthObservation } from '../mcp/mcp-contract.js';

function observation(overrides: Partial<McpAuthObservation> = {}): McpAuthObservation {
  return {
    state: 'ready',
    checkedAt: '2025-01-01T00:00:00.000Z',
    message: 'Tool inventory succeeded.',
    ...overrides,
  };
}

describe('mcp-auth-observation-repo', () => {
  it('retains interrupted native challenges across repository recreation', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const value = observation({ state: 'unknown', interrupted: true });
    createMcpAuthObservationRepo(db).put('interrupted', value);
    expect(createMcpAuthObservationRepo(db).load()).toEqual([{ key: 'interrupted', state: value }]);
    db.close();
  });

  it('upgrades old observation rows without losing their recorded state', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    db.exec('ALTER TABLE mcp_auth_observations DROP COLUMN interrupted');
    db.prepare('INSERT INTO mcp_auth_observations (key, state, checked_at, message, recorded_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy', 'required', null, 'Existing challenge', 'before upgrade');
    applySchema(db);
    expect(createMcpAuthObservationRepo(db).load()).toEqual([{
      key: 'legacy', state: { state: 'required', checkedAt: null, message: 'Existing challenge' },
    }]);
    db.close();
  });
  it('persists an observation and loads it back', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMcpAuthObservationRepo(db);
    repo.put('key-a', observation({ state: 'required', checkedAt: null, message: 'Sign-in needed.' }));
    expect(repo.load()).toEqual([
      { key: 'key-a', state: { state: 'required', checkedAt: null, message: 'Sign-in needed.' } },
    ]);
    db.close();
  });

  it('re-inserting a key moves it to the end of load order', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMcpAuthObservationRepo(db);
    repo.put('key-a', observation({ state: 'ready' }));
    repo.put('key-b', observation({ state: 'expired' }));
    repo.put('key-a', observation({ state: 'required', message: 'Re-observed.' }));
    expect(repo.load().map((row) => row.key)).toEqual(['key-b', 'key-a']);
    expect(repo.load()[1].state).toEqual({ state: 'required', checkedAt: '2025-01-01T00:00:00.000Z', message: 'Re-observed.' });
    db.close();
  });

  it('deletes an observation by key', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMcpAuthObservationRepo(db);
    repo.put('key-a', observation());
    repo.put('key-b', observation());
    repo.delete('key-a');
    expect(repo.load().map((row) => row.key)).toEqual(['key-b']);
    db.close();
  });
});
