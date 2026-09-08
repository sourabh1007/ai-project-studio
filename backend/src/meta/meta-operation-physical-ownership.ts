import { createWorkTracker } from '../kernel/work-tracker.js';
import type { ManagedMetaOperationPhysicalOwnership, MetaOperationPhysicalOwner, MetaOperationPhysicalRegistration } from './meta-operation-contract.js';

/** Certifies only this path's preflight rejection, never earlier fallback attempts. */
export function registerUnstartedMetaAttempt(
  physical: MetaOperationPhysicalRegistration | undefined,
  operationId: string | undefined,
): void {
  if (!physical || !operationId) return;
  physical.register(operationId, {
    ownerId: physical.newOwnerId(),
    settled: Promise.resolve('not-started'),
    quiesce: async () => 'not-started',
  });
}

interface Operation {
  expected: boolean;
  closing: boolean;
  sealed: boolean;
  registered: Set<string>;
  pending: Map<string, MetaOperationPhysicalOwner>;
  releases: Map<string, () => void>;
  complete: (proof: 'confirmed' | 'unknown') => void;
  completion: Promise<'confirmed' | 'unknown'>;
}

export function createMetaOperationPhysicalOwnership(deps: {
  newOwnerId(): string;
}): ManagedMetaOperationPhysicalOwnership {
  const operations = new Map<string, Operation>();
  const work = createWorkTracker<string>();
  const finish = (id: string, operation: Operation) => {
    if (!operation.sealed || operation.pending.size !== 0) return;
    const proof = operation.expected && operation.registered.size === 0 ? 'unknown' : 'confirmed';
    operation.complete(proof);
    if (proof === 'confirmed' && operations.get(id) === operation) operations.delete(id);
  };
  const get = (id: string) => {
    const operation = operations.get(id);
    if (!operation) throw new Error('Physical operation is not admitted');
    return operation;
  };
  return {
    newOwnerId: deps.newOwnerId,
    begin(id) {
      if (operations.has(id)) throw new Error('Physical operation is already admitted');
      let complete!: Operation['complete'];
      const completion = new Promise<'confirmed' | 'unknown'>((resolve) => { complete = resolve; });
      operations.set(id, { expected: false, closing: false, sealed: false, registered: new Set(), pending: new Map(), releases: new Map(), complete, completion });
    },
    expect(id) { get(id).expected = true; },
    register(id, owner) {
      const operation = get(id);
      if (operation.sealed || operation.registered.has(owner.ownerId)) throw new Error('Physical attempt admission is closed');
      operation.registered.add(owner.ownerId);
      if (operation.closing) throw new Error('Physical attempt admission is closed');
      operation.pending.set(owner.ownerId, owner);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      operation.releases.set(owner.ownerId, release);
      void work.own(id, () => pending);
      owner.settled.then(() => {
        operation.pending.delete(owner.ownerId);
        operation.releases.delete(owner.ownerId);
        finish(id, operation);
        release();
      }, () => {
        // A rejected completion is not native exit. Keep ownership for explicit proof.
      });
    },
    async quiesce(id, timeoutMs) {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid physical operation timeout');
      const operation = operations.get(id);
      if (!operation) return 'unknown';
      operation.closing = true;
      const attempts = [...operation.pending.values()];
      for (const owner of attempts) {
        // The settlement subscription above owns completion; retries do not add exit listeners.
        void owner.quiesce(0).catch(() => {});
      }
      const idle = await work.waitForIdle(timeoutMs, (key) => key === id);
      if (!idle) return 'unconfirmed';
      return operation.registered.size === 0 ? 'unknown' : 'confirmed';
    },
    seal(id) {
      const operation = get(id);
      operation.closing = true;
      operation.sealed = true;
      finish(id, operation);
      return operation.completion;
    },
    forget(id) {
      const operation = operations.get(id);
      if (!operation) return;
      operation.complete('confirmed');
      for (const release of operation.releases.values()) release();
      operations.delete(id);
    },
  };
}
