import type { AbortTracker } from '../kernel/abort-tracker.js';
import type { MetaRequest, MetaRunResult, MetaRunner } from './meta-runner.js';

/**
 * Wraps a meta runner with process-lifetime ownership so shutdown can abort
 * and await every in-flight headless AI run without changing its callers.
 */
export function createOwnedMetaRunner(
  base: MetaRunner,
  owner: Pick<AbortTracker, 'own'>,
): MetaRunner {
  const runDetailed = (request: MetaRequest): Promise<MetaRunResult> =>
    owner.own(
      (signal) =>
        base.runDetailed({
          ...request,
          signal,
        }),
      request.signal,
    );

  return {
    run: async (request) => (await runDetailed(request)).text,
    runDetailed,
  };
}
