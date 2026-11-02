import type { MetaRequest, MetaRunResult, MetaRunner } from '../meta/meta-runner.js';
import type { ProviderExecutionPolicy } from './active-provider.js';

/** Outer boundary: owns queued work before recording, routing, or pool awaits. */
export function createExclusiveMetaRunner(
  base: MetaRunner,
  executionPolicy: ProviderExecutionPolicy,
): MetaRunner {
  const runDetailed = async (request: MetaRequest): Promise<MetaRunResult> => {
    const lease = executionPolicy.acquire(request.providerId, {
      kind: 'meta',
      id: request.operationId ?? request.featureId,
      label: 'Headless AI request',
    });
    try {
      return await base.runDetailed({ ...request, providerId: lease.providerId });
    } finally {
      lease.release();
    }
  };
  return {
    run: async (request) => (await runDetailed(request)).text,
    runDetailed,
  };
}
