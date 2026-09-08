import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
import type {
  Subagent,
  SubagentRepo,
} from './automation-contract.js';
import type { SubagentEventMap } from './subagent-service.js';

export const INTERRUPTED_SUBAGENT_MESSAGE =
  'Interrupted by a restart before it finished.';

export interface SubagentReconcilerDeps {
  repo: SubagentRepo;
  clock: Clock;
  bus?: EventBus<SubagentEventMap>;
}

function isTerminal(status: Subagent['status']): boolean {
  return status === 'done' || status === 'failed';
}

export function createSubagentReconciler(deps: SubagentReconcilerDeps): {
  reconcileOrphans(): number;
} {
  return {
    reconcileOrphans() {
      const failedAt = deps.clock.isoNow();
      let count = 0;
      for (const subagent of deps.repo.list()) {
        if (isTerminal(subagent.status)) {
          continue;
        }
        const failed: Subagent = {
          ...subagent,
          status: 'failed',
          result: subagent.result ?? INTERRUPTED_SUBAGENT_MESSAGE,
          updatedAt: failedAt,
        };
        deps.repo.save(failed);
        deps.bus?.emit('subagent.updated', failed);
        count += 1;
      }
      return count;
    },
  };
}
