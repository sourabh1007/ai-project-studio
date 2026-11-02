import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteUnitOfWork } from './sqlite-unit-of-work.js';
import { UnitOfWorkPoisonedError, UnitOfWorkUncertainError, passthroughUnitOfWork } from './unit-of-work.js';

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE t (v INTEGER)');
  return d;
}
const count = (d: DatabaseSync): number => Number((d.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n);

describe('createSqliteUnitOfWork', () => {
  it('commits and returns the result', () => {
    const d = db();
    expect(createSqliteUnitOfWork(d).run(() => { d.exec('INSERT INTO t VALUES (1)'); return 'ok'; })).toBe('ok');
    expect(count(d)).toBe(1);
    expect(d.isTransaction).toBe(false);
  });

  it('rolls back everything when the work throws', () => {
    const d = db();
    expect(() => createSqliteUnitOfWork(d).run(() => { d.exec('INSERT INTO t VALUES (1)'); throw new Error('x'); })).toThrow('x');
    expect(count(d)).toBe(0);
    expect(d.isTransaction).toBe(false);
  });

  it('joins an enclosing transaction instead of nesting', () => {
    const d = db();
    d.exec('BEGIN');
    expect(createSqliteUnitOfWork(d).nested).toBe(true);
    createSqliteUnitOfWork(d).run(() => d.exec('INSERT INTO t VALUES (1)'));
    expect(d.isTransaction).toBe(true);
    d.exec('ROLLBACK');
    expect(count(d)).toBe(0);
  });

  it('treats a transaction SQLite already rolled back as definitely rolled back', () => {
    const d = db();
    expect(() => createSqliteUnitOfWork(d).run(() => { d.exec('ROLLBACK'); throw new Error('gone'); })).toThrow('gone');
  });

  it('rethrows the commit failure when rollback is confirmed', () => {
    const d = db();
    d.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    d.exec('CREATE TABLE c (pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
    d.exec('PRAGMA foreign_keys = ON');
    expect(() => createSqliteUnitOfWork(d).run(() => d.exec('INSERT INTO c VALUES (99)'))).toThrow(/FOREIGN KEY/);
    expect(d.isTransaction).toBe(false);
  });

  it('reports an uncertain outcome when commit fails and rollback cannot be confirmed', () => {
    let checks = 0;
    const fake = {
      exec: (sql: string) => { if (sql !== 'BEGIN IMMEDIATE') throw new Error(`${sql} failed`); },
      get isTransaction() { return checks++ > 0; },
    } as unknown as DatabaseSync;
    expect(() => createSqliteUnitOfWork(fake).run(() => 1)).toThrow(UnitOfWorkUncertainError);
  });

  it('reports an uncertain outcome when the work failed and rollback cannot be confirmed', () => {
    let first = true;
    const fake = {
      exec: (sql: string) => { if (sql === 'ROLLBACK') throw new Error('no'); },
      get isTransaction() { if (first) { first = false; return false; } return true; },
    } as unknown as DatabaseSync;
    expect(() => createSqliteUnitOfWork(fake).run(() => { throw new Error('work'); })).toThrow(UnitOfWorkUncertainError);
  });
});

describe('passthroughUnitOfWork', () => {
  it('just runs the function', () => {
    expect(passthroughUnitOfWork.run(() => 7)).toBe(7);
  });
});

describe('poisoned connection', () => {
  it('is healthy and not nested by default', () => {
    const uow = createSqliteUnitOfWork(db());
    expect(uow.poisoned).toBe(false);
    expect(uow.nested).toBe(false);
  });

  it('refuses all later work after an uncertain commit', () => {
    let checks = 0;
    const fake = {
      exec: (sql: string) => { if (sql !== 'BEGIN IMMEDIATE') throw new Error(`${sql} failed`); },
      get isTransaction() { return checks++ > 0; },
    } as unknown as DatabaseSync;
    const uow = createSqliteUnitOfWork(fake);
    expect(() => uow.run(() => 1)).toThrow(UnitOfWorkUncertainError);
    expect(uow.poisoned).toBe(true);
    let ran = false;
    expect(() => uow.run(() => { ran = true; })).toThrow(UnitOfWorkPoisonedError);
    expect(ran).toBe(false);
  });

  it('is not poisoned by a confirmed rollback, and a fresh unit of work recovers', () => {
    const d = db();
    const uow = createSqliteUnitOfWork(d);
    expect(() => uow.run(() => { throw new Error('x'); })).toThrow('x');
    expect(uow.poisoned).toBe(false);
    expect(uow.run(() => 1)).toBe(1);
  });
});
describe('onPoisoned', () => {
  const uncertainDb = () => {
    let checks = 0;
    return {
      exec: (sql: string) => { if (sql !== 'BEGIN IMMEDIATE') throw new Error(`${sql} failed`); },
      get isTransaction() { return checks++ > 0; },
    } as unknown as DatabaseSync;
  };

  it('is called once with the cause after the flag is set, and later runs are refused without calling it again', () => {
    const calls: Array<[Error, boolean]> = [];
    const holder: { uow?: ReturnType<typeof createSqliteUnitOfWork> } = {};
    holder.uow = createSqliteUnitOfWork(uncertainDb(), {
      onPoisoned: (error) => { calls.push([error as Error, holder.uow?.poisoned ?? false]); },
    });
    expect(() => holder.uow?.run(() => 1)).toThrow(UnitOfWorkUncertainError);
    expect(() => holder.uow?.run(() => 1)).toThrow(UnitOfWorkPoisonedError);
    expect(calls).toHaveLength(1);
    expect(calls[0][0].message).toBe('COMMIT failed');
    expect(calls[0][1]).toBe(true);
  });

  it('keeps the uncertain error and the flag when the callback throws', () => {
    const uow = createSqliteUnitOfWork(uncertainDb(), { onPoisoned: () => { throw new Error('close failed'); } });
    expect(() => uow.run(() => 1)).toThrow(UnitOfWorkUncertainError);
    expect(uow.poisoned).toBe(true);
  });

  it('is not called for a confirmed rollback', () => {
    const calls: unknown[] = [];
    const uow = createSqliteUnitOfWork(db(), { onPoisoned: (e) => calls.push(e) });
    expect(() => uow.run(() => { throw new Error('x'); })).toThrow('x');
    expect(calls).toEqual([]);
  });
});