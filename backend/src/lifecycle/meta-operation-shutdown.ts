import { ConflictError } from '../kernel/error-types.js';
import type { MetaOperationOwnership } from '../meta/meta-operation-contract.js';

export function createMetaOperationShutdown(deps: {
  ownership: Pick<MetaOperationOwnership, 'quiesceAll' | 'unconfirmed' | 'confirmTermination'>;
  timeoutMs: number;
  reportError: (error: unknown) => void;
}) {
  let closed = false;
  let initialWait: Promise<boolean> | undefined;
  return {
    abort(): void {
      closed = true;
      initialWait = deps.ownership.quiesceAll(deps.timeoutMs);
      void initialWait.catch(deps.reportError);
    },
    /** Only the global shutdown path may call this after all provider owners confirm exit. */
    async settleAfterPhysicalDrain(): Promise<void> {
      if (!closed) throw new Error('Meta operation admission must close before shutdown reconciliation');
      for (const operation of deps.ownership.unconfirmed()) {
        deps.ownership.confirmTermination(operation.operationId);
      }
      const previous = initialWait;
      initialWait = undefined;
      if (previous) await previous;
      if (!await deps.ownership.quiesceAll(deps.timeoutMs)) {
        throw new ConflictError('Meta operation completion remains unconfirmed');
      }
    },
  };
}
