import type { Clock } from '../kernel/clock.js';
import type { MetaOperationRepo } from './meta-operation-contract.js';

export interface MetaOperationRecoveryDeps {
  operations: Pick<MetaOperationRepo, 'listUnfinishedPage' | 'update'>;
  clock: Clock;
}

/** Run before new admission; reconciles interrupted capture, never re-executes AI. */
export function createMetaOperationRecovery(deps: MetaOperationRecoveryDeps) {
  return {
    recoverPage(afterOperationId: string | null, limit: number): { recovered: number; nextCursor: string | null } {
      const page = deps.operations.listUnfinishedPage(afterOperationId, limit);
      let recovered = 0;
      for (const operation of page.items) {
        if (deps.operations.update({
          ...operation, state: 'interrupted', outcome: 'unknown',
          errorMessage: 'Application stopped before durable operation completion',
          updatedAt: deps.clock.isoNow(), finishedAt: deps.clock.isoNow(),
        })) recovered += 1;
      }
      return { recovered, nextCursor: page.nextCursor };
    },
  };
}
