import type { UsageRepo } from '../usage/usage-repo-port.js';
import type { MetaUsage, MetaUsageReader } from './pr-review-contract.js';

export interface MetaUsageReaderDeps {
  usage: Pick<UsageRepo, 'listBySession'>;
}

/**
 * Reads the tokens and credits a metasession spent by summing its recorded usage
 * events. Backs the PR review's per-step metasession accounting so each analysis
 * step can surface exactly what its metasession cost, regardless of the
 * `internal` scope that keeps meta usage out of the normal dev rollups.
 */
export function createMetaUsageReader(deps: MetaUsageReaderDeps): MetaUsageReader {
  return {
    usageForSession(sessionId) {
      const events = deps.usage.listBySession(sessionId);
      if (events.length === 0) {
        return null;
      }
      const usage: MetaUsage = {
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        nanoAiu: 0,
        credits: 0,
      };
      for (const event of events) {
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
        usage.nanoAiu += event.nanoAiu;
        usage.credits += event.credits;
      }
      return usage;
    },
  };
}
