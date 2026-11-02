import { ConflictError } from '../kernel/error-types.js';
import type { ProviderExecutionBlocker } from './active-provider.js';

export interface ProviderSwitchDrainDeps {
  blockers(): ProviderExecutionBlocker[];
  quotaCapturing(): boolean;
  stopQuota(): void;
  drainTerminals(timeoutMs: number): Promise<boolean>;
  drainWarmWorkers(timeoutMs: number): Promise<boolean>[];
  onDrained(): void;
  timeoutMs: number;
}

/** Called under the execution-policy fence; termination requests never count as exit proof. */
export function createProviderSwitchDrain(deps: ProviderSwitchDrainDeps): () => Promise<void> {
  return async () => {
    const blockers = deps.blockers();
    const unsafe = blockers.filter((entry) =>
      entry.kind !== 'terminal' && entry.kind !== 'warm' && entry.kind !== 'process' &&
      !(entry.kind === 'probe' && entry.id === 'plan-usage'));
    if (unsafe.length > 0 || deps.quotaCapturing()) {
      throw new ConflictError('Wait for background AI work to finish before switching CLI', { blockers });
    }
    deps.stopQuota();
    const confirmed = await Promise.all([
      deps.drainTerminals(deps.timeoutMs), ...deps.drainWarmWorkers(deps.timeoutMs),
    ]);
    if (confirmed.some((exited) => !exited)) {
      throw new ConflictError('CLI termination is not confirmed. Switching remains blocked.', { blockers: deps.blockers() });
    }
    deps.onDrained();
  };
}
