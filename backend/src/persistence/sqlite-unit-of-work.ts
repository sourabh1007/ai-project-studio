import type { DatabaseSync } from 'node:sqlite';
import { UnitOfWorkPoisonedError, UnitOfWorkUncertainError, type UnitOfWork } from './unit-of-work.js';

/**
 * SQLite {@link UnitOfWork}. Takes the write lock up front (`BEGIN IMMEDIATE`)
 * so a concurrent writer fails fast instead of deadlocking on upgrade, and
 * joins an enclosing transaction rather than nesting one.
 */
export interface SqliteUnitOfWorkOptions {
  /**
   * Called once, after the poisoned flag is set, with the uncertain error. It lets
   * the owner quarantine the shared handle (for example close it); a throwing
   * callback never replaces the uncertain outcome.
   */
  onPoisoned?: (error: unknown) => void;
}

export function createSqliteUnitOfWork(db: DatabaseSync, options: SqliteUnitOfWorkOptions = {}): UnitOfWork {
  // SQLite may already have rolled back on its own (ROLLBACK then reports "no
  // transaction"); the work is only unconfirmed while a transaction stays open.
  const rolledBack = (): boolean => {
    try {
      db.exec('ROLLBACK');
      return true;
    } catch {
      return !db.isTransaction;
    }
  };
  let poisoned = false;
  const poison = (error: unknown): never => {
    poisoned = true;
    const uncertain = new UnitOfWorkUncertainError(error);
    try {
      options.onPoisoned?.(error);
    } catch {
      // The reporter is best effort; the uncertain outcome below is what callers must see.
    }
    throw uncertain;
  };
  return {
    get nested() { return db.isTransaction; },
    get poisoned() { return poisoned; },
    run<T>(fn: () => T): T {
      if (poisoned) throw new UnitOfWorkPoisonedError();
      if (db.isTransaction) return fn();
      db.exec('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = fn();
      } catch (error) {
        if (!rolledBack()) poison(error);
        throw error;
      }
      try {
        db.exec('COMMIT');
      } catch (commitError) {
        if (!rolledBack()) poison(commitError);
        throw commitError;
      }
      return result;
    },
  };
}
