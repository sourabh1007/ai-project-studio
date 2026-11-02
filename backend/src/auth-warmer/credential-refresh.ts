import { ConflictError } from '../kernel/error-types.js';
import { authWarmerDefaults } from './config.js';

export interface CredentialRefresh<T> {
  refresh(): Promise<void>;
  generation(): number;
  invalidate(): number;
  publish(generation: number, value: T): void;
  run<R>(operation: () => Promise<R>): Promise<R>;
  suspend(value: T): Promise<() => void>;
  suspended(): boolean;
}

export function createCredentialRefresh<T>(deps: {
  read: () => Promise<T>;
  apply: (value: T) => void;
  maxConcurrentReads?: number;
}): CredentialRefresh<T> {
  let generation = 0;
  let suspensions = 0;
  const reads = new Set<Promise<unknown>>();
  let active: { generation: number; promise: Promise<void> } | null = null;

  function publish(expected: number, value: T): void {
    if (expected === generation && suspensions === 0) deps.apply(value);
  }

  function run<R>(operation: () => Promise<R>): Promise<R> {
    if (suspensions > 0) return Promise.reject(new ConflictError('Account sign-out is in progress. Try again after it completes.'));
    if (reads.size >= (deps.maxConcurrentReads ?? authWarmerDefaults.maxConcurrentReads)) {
      return Promise.reject(new ConflictError('Credential operations are busy. Wait for the current checks to finish.'));
    }
    const request = Promise.resolve().then(operation);
    reads.add(request);
    return request.finally(() => { reads.delete(request); });
  }

  function refresh(): Promise<void> {
    if (suspensions > 0) return Promise.resolve();
    if (active) {
      if (active.generation === generation) return active.promise;
      const expected = generation;
      return active.promise.then(
        () => {
          if (expected === generation) return refresh();
          return undefined;
        },
        (error: unknown) => {
          if (expected === generation) return refresh();
          throw error;
        },
      );
    }
    const expected = generation;
    const promise = run(deps.read)
      .then((value) => publish(expected, value))
      .finally(() => { active = null; });
    active = { generation: expected, promise };
    return promise;
  }

  return {
    refresh, publish, run,
    generation: () => generation,
    invalidate: () => ++generation,
    suspended: () => suspensions > 0,
    async suspend(value) {
      generation += 1;
      suspensions += 1;
      try {
        deps.apply(value);
      } catch (error) {
        suspensions -= 1;
        throw error;
      }
      await Promise.allSettled([...reads]);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        generation += 1;
        suspensions -= 1;
      };
    },
  };
}
