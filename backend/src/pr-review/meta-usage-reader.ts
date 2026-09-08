import type { MetaUsageRepo } from '../meta/meta-usage-contract.js';
import type { UsageRepo } from '../usage/usage-repo-port.js';
import type { MetaUsageReader } from './pr-review-contract.js';

export interface MetaUsageReaderDeps {
  usage: Pick<UsageRepo, 'listBySession'>;
  warmUsage?: MetaUsageRepo;
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
        const warm = deps.warmUsage?.get(sessionId);
        if (!warm) {
          return null;
        }
        return {
          sessionId,
          inputTokens: warm.inputTokens,
          outputTokens: warm.outputTokens,
          nanoAiu: warm.nanoAiu,
          credits: warm.credits,
        };
      }
      let inputTokens = 0;
      let outputTokens = 0;
      let nanoAiu = 0;
      let credits = 0;
      for (const event of events) {
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        nanoAiu += event.nanoAiu;
        credits += event.credits;
      }
      return {
        sessionId,
        inputTokens,
        outputTokens,
        nanoAiu,
        credits,
      };
    },
  };
}
