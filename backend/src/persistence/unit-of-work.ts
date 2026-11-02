/**
 * Synchronous atomic unit of work. `fn` must be synchronous: a SQLite
 * transaction is never held across an await. Everything `fn` writes commits
 * together or not at all.
 */
export interface UnitOfWork {
  run<T>(fn: () => T): T;
  /** True while `run` would join a transaction it does not control and so cannot prove a commit. */
  readonly nested: boolean;
  /**
   * True after an unconfirmed commit/rollback. The connection may still hold an
   * open transaction, so nothing read or written through it is trustworthy until
   * it is replaced; `run` refuses to start.
   */
  readonly poisoned: boolean;
}

/** Runs `fn` directly; for tests and callers that have no shared database. */
export const passthroughUnitOfWork: UnitOfWork = { run: (fn) => fn(), nested: false, poisoned: false };

/**
 * COMMIT failed and the ROLLBACK that should have followed also failed, so it
 * is unknown whether the writes are durable. Callers must treat the outcome as
 * uncertain rather than retry or report success.
 */
export class UnitOfWorkUncertainError extends Error {
  constructor(readonly cause: unknown) {
    super('Transaction outcome is unknown: commit failed and rollback could not be confirmed');
    this.name = 'UnitOfWorkUncertainError';
  }
}

/** Thrown by `run` on a poisoned connection; nothing was attempted. */
export class UnitOfWorkPoisonedError extends Error {
  constructor() {
    super('Database connection is quarantined after an unconfirmed transaction; reopen it');
    this.name = 'UnitOfWorkPoisonedError';
  }
}
