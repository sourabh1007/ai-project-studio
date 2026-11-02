import { createHash } from 'node:crypto';
import { AppError, ConflictError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import { UnitOfWorkUncertainError, type UnitOfWork } from '../persistence/unit-of-work.js';
import type { ClientOperationsConfig } from './config.js';
import {
  OPERATION_CAPACITY,
  OPERATION_KEY_CONFLICT,
  OPERATION_PENDING,
  OPERATION_UNHEALTHY,
  type ClientOperationRecord,
  type ClientOperationRepo,
  type ClientOperations,
  type OperationResult,
} from './client-operations-contract.js';

export interface ClientOperationsDeps {
  repo: ClientOperationRepo;
  unitOfWork: UnitOfWork;
  clock: Clock;
  config: ClientOperationsConfig;
}

const KEY_PATTERN = /^[A-Za-z0-9._:~-]+$/;

/** Key-order independent JSON so the same input always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Durable idempotency for creates. The key is reserved before any await; the
 * resource write and the success record commit together in one synchronous
 * unit of work, which first re-reads the record: if another executor already
 * committed it the stored result is returned and `write` never runs; if the
 * reservation is missing or belongs to different input nothing is written. A
 * pending record (crash, or an executor on another service/connection that is
 * still preparing) is therefore safely resumed: the work before `commit` must
 * be side-effect free, and exactly one executor can win the commit. Pending
 * records are never pruned for capacity or age. After an unconfirmed
 * transaction the connection is quarantined and every operation is refused.
 */
export function createClientOperations(deps: ClientOperationsDeps): ClientOperations {
  const { repo, unitOfWork, clock, config } = deps;
  const inFlight = new Map<string, { hash: string; promise: Promise<OperationResult> }>();

  const keyConflict = (): ConflictError => new ConflictError(
    'This operation key was already used with different input',
    { code: OPERATION_KEY_CONFLICT },
  );

  const stored = (record: ClientOperationRecord): OperationResult =>
    ({ status: record.status as number, body: JSON.parse(record.responseJson as string) });

  const unhealthy = (): AppError => new AppError(
    'unavailable', 'The database connection is quarantined after an unconfirmed transaction; restart the backend',
    { code: OPERATION_UNHEALTHY },
  );

  function reserve(scope: string, key: string, hash: string): OperationResult | undefined {
    const existing = repo.get(scope, key);
    if (existing !== undefined) {
      if (existing.requestHash !== hash) throw keyConflict();
      return existing.state === 'pending' ? undefined : stored(existing);
    }
    const nowMs = clock.now().getTime();
    repo.pruneSucceeded(nowMs - config.retentionMs, config.pruneBatch);
    if (repo.count() >= config.maxRecords) {
      throw new AppError('unavailable', 'Too many unresolved operations are stored; retry later', {
        code: OPERATION_CAPACITY,
      });
    }
    repo.reservePending(scope, key, hash, nowMs);
    return undefined;
  }

  return {
    keyFrom(headers) {
      const header = headers?.[config.headerName];
      if (header === undefined) return null;
      if (typeof header !== 'string' || header.length === 0 || header.length > config.maxKeyLength
        || !KEY_PATTERN.test(header)) {
        throw new ValidationError('Invalid operation key');
      }
      return header;
    },

    async run(request, execute) {
      const { scope, key } = request;
      if (unitOfWork.poisoned) throw unhealthy();
      if (key === null) return runDirect(execute);
      const id = `${scope}\0${key}`;
      const hash = createHash('sha256').update(canonical(request.fingerprint)).digest('hex');
      const running = inFlight.get(id);
      if (running !== undefined) {
        if (running.hash !== hash) throw keyConflict();
        return running.promise;
      }
      const replay = reserve(scope, key, hash);
      if (replay !== undefined) return replay;
      const promise = perform(scope, key, hash, execute);
      inFlight.set(id, { hash, promise });
      const clear = (): void => { inFlight.delete(id); };
      promise.then(clear, clear);
      return promise;
    },
  };

  async function runDirect(execute: (commit: (write: () => OperationResult) => OperationResult) => Promise<unknown>): Promise<OperationResult> {
    let result: OperationResult | undefined;
    await execute((write) => (result = write()));
    return finish(result);
  }

  async function perform(
    scope: string,
    key: string,
    hash: string,
    execute: (commit: (write: () => OperationResult) => OperationResult) => Promise<unknown>,
  ): Promise<OperationResult> {
    let committed: OperationResult | undefined;
    let uncertain = false;
    const commit = (write: () => OperationResult): OperationResult => {
      if (unitOfWork.poisoned) throw unhealthy();
      // A joined outer transaction could still roll the success record back.
      if (unitOfWork.nested) throw new Error('Operations cannot commit inside another transaction');
      try {
        return unitOfWork.run(() => {
          const current = repo.get(scope, key);
          if (current === undefined || current.requestHash !== hash) {
            throw new ConflictError('The operation reservation changed; retry with the same key', {
              code: OPERATION_PENDING,
            });
          }
          if (current.state === 'succeeded') {
            const replayed = stored(current);
            committed = replayed;
            return replayed;
          }
          const result = write();
          const completed = repo.complete(scope, key, result.status, JSON.stringify(result.body), clock.now().getTime());
          if (!completed) throw new Error('Operation record was not pending');
          committed = result;
          return result;
        });
      } catch (error) {
        if (error instanceof UnitOfWorkUncertainError) uncertain = true;
        // The unit of work may have committed in a later step than `write`.
        committed = undefined;
        throw error;
      }
    };
    try {
      await execute(commit);
    } catch (error) {
      if (committed !== undefined) return committed;
      if (!uncertain) releaseSafely(scope, key, hash);
      throw error;
    }
    if (committed === undefined) {
      if (!uncertain) releaseSafely(scope, key, hash);
      throw new Error('Operation finished without committing a result');
    }
    return committed;
  }

  function releaseSafely(scope: string, key: string, hash: string): void {
    if (unitOfWork.poisoned) return;
    try {
      repo.releasePending(scope, key, hash);
    } catch {
      // Keep the record: a stuck pending key is refused, never silently re-run.
    }
  }

  function finish(result: OperationResult | undefined): OperationResult {
    if (result === undefined) throw new Error('Operation finished without committing a result');
    return result;
  }
}
