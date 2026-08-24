import type {
  MetaRequest,
  MetaRunResult,
  MetaRunner,
} from './meta-runner.js';
import type { MetaSessionPoolStats } from './acp/acp-pool.js';

/**
 * One warm pool bound to a routing purpose. The pooled runner leases turns from
 * the pool whose {@link purpose} matches a request, so warm capacity can be
 * dedicated per workflow (e.g. `review`, `general`).
 */
export interface PurposePool {
  /** Stable routing key matched against {@link MetaRequest.purpose}. */
  purpose: string;
  /** True once at least one warm session is ready to serve a turn. */
  ready(): boolean;
  /** Live warm-capacity snapshot for status surfaces. */
  stats(): MetaSessionPoolStats;
  /** Runs a single turn on a warm session in this pool. */
  runDetailed(request: MetaRequest): Promise<MetaRunResult>;
}

export interface PooledMetaRunnerDeps {
  /** The warm pools, one per purpose. Must include a `general` pool. */
  pools: readonly PurposePool[];
  /** Cold runner used while pools warm up or when a warm turn fails. */
  fallback: MetaRunner;
  /** Logs a warm-turn failure before falling back (optional). */
  onFallback?: (purpose: string, error: unknown) => void;
}

/** Purpose used for requests that don't match a dedicated pool. */
export const GENERAL_PURPOSE = 'general';

/**
 * A {@link MetaRunner} that prefers warm `copilot --acp` sessions and falls back
 * to the cold runner transparently. Requests route to the pool matching
 * {@link MetaRequest.purpose} (or the shared `general` pool). If the chosen pool
 * is still warming, or a warm turn throws, the cold runner serves the request so
 * callers never fail just because the pool isn't ready — they only get faster
 * when it is.
 */
export function createPooledMetaRunner(deps: PooledMetaRunnerDeps): MetaRunner {
  const byPurpose = new Map(deps.pools.map((pool) => [pool.purpose, pool]));
  const general = byPurpose.get(GENERAL_PURPOSE);

  function select(purpose: string | undefined): PurposePool | undefined {
    if (purpose) {
      const match = byPurpose.get(purpose);
      if (match) {
        return match;
      }
    }
    return general;
  }

  async function runDetailed(request: MetaRequest): Promise<MetaRunResult> {
    const pool = select(request.purpose);
    if (pool && pool.ready()) {
      try {
        return await pool.runDetailed(request);
      } catch (error) {
        deps.onFallback?.(pool.purpose, error);
      }
    }
    return deps.fallback.runDetailed(request);
  }

  return {
    runDetailed,
    async run(request: MetaRequest): Promise<string> {
      return (await runDetailed(request)).text;
    },
  };
}

/** Aggregate warm-pool status for the settings surface. */
export interface MetaPoolsStatus {
  enabled: boolean;
  pools: Array<{ purpose: string } & MetaSessionPoolStats>;
}

/** Builds a live status snapshot from the configured purpose pools. */
export function metaPoolsStatus(
  enabled: boolean,
  pools: readonly Pick<PurposePool, 'purpose' | 'stats'>[],
): MetaPoolsStatus {
  return {
    enabled,
    pools: pools.map((pool) => ({ purpose: pool.purpose, ...pool.stats() })),
  };
}
