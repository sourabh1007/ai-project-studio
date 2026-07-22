import type { CreditCalculator } from '../credit/credit-calculator.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { SessionKind } from '../provider/provider-contract.js';
import type { UsageEvent } from './usage-contract.js';
import type { StoredUsage, UsageRepo } from './usage-repo-port.js';

/** Event emitted after a usage event is credited and persisted. */
export type UsageRecordedMap = {
  'usage.recorded': StoredUsage;
};

export interface UsageRecorderDeps {
  calculator: CreditCalculator;
  repo: UsageRepo;
  bus: EventBus<UsageRecordedMap>;
}

export interface UsageRecorder {
  record(event: UsageEvent, kind: SessionKind): StoredUsage;
  recordAll(events: UsageEvent[], kind: SessionKind): StoredUsage[];
}

/**
 * Write-path pipeline: credits each UsageEvent, persists it, and publishes a
 * 'usage.recorded' event for the live meter and aggregation read side.
 */
export function createUsageRecorder(deps: UsageRecorderDeps): UsageRecorder {
  const toStored = (event: UsageEvent, kind: SessionKind): StoredUsage => ({
    ...event,
    credits: deps.calculator.calculate(event).credits,
    kind,
  });

  const persist = (stored: StoredUsage[]): void => {
    deps.repo.saveAll(stored);
    for (const s of stored) {
      deps.bus.emit('usage.recorded', s);
    }
  };

  return {
    record(event, kind) {
      const stored = toStored(event, kind);
      persist([stored]);
      return stored;
    },
    recordAll(events, kind) {
      const stored = events.map((e) => toStored(e, kind));
      persist(stored);
      return stored;
    },
  };
}
