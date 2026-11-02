import { describe, it, expect, vi } from 'vitest';
import { createDatabase } from './db/connection.js';
import { readUsageSummarySnapshot } from './usage-summary-snapshot.js';

describe('readUsageSummarySnapshot', () => {
  it('reads the summary inside one transaction', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    db.prepare("INSERT INTO features (id, name, description, created_at) VALUES ('f', 'f', '', 'x')").run();
    const exec = vi.spyOn(db, 'exec');
    const summary = readUsageSummarySnapshot(db, ['dev', 'meta']);
    expect(summary.features.f.state).toBe('none');
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    db.close();
  });

  it('closes the transaction when a read fails', () => {
    const exec = vi.fn();
    const failing = { all: () => { throw new Error('boom'); } };
    const db = { exec, prepare: () => failing } as never;
    expect(() => readUsageSummarySnapshot(db, ['dev'])).toThrow('boom');
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
  });
});
