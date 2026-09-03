import type {
  MetaRequest,
  MetaRunResult,
  MetaRunner,
} from './meta-runner.js';
import type { MetaSessionPoolStats } from './acp/acp-pool.js';
import type { PoolDemand, PoolDemandPort } from './pool-demand.js';

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
  /**
   * When it returns `true` the warm pools are skipped entirely and the request
   * runs on the cold {@link fallback}. Used to honor a runtime model override:
   * warm ACP sessions are pinned to the CLI's default model, so a request that
   * needs a specific model must take the cold path where the model is applied.
   */
  bypass?: () => boolean;
  /**
   * Optional demand telemetry. Every routed turn (warm or spilled to cold) is
   * counted per purpose so the Settings page can suggest a warm size from
   * observed peak concurrency.
   */
  demand?: PoolDemandPort;
}

/** Purpose used for requests that don't match a dedicated pool. */
export const GENERAL_PURPOSE = 'general';

/**
 * A {@link MetaRunner} that prefers warm `copilot --acp` sessions and falls back
 * to the cold runner transparently. Requests route to the pool matching
 * {@link MetaRequest.purpose} (or the shared `general` pool).
 *
 * Parallelism is bounded by each pool's size: a warm turn is only taken when the
 * pool reports a session ready to lease ({@link PurposePool.ready}), so at most
 * `size` turns run warm-concurrently per purpose. When a pool is still warming,
 * saturated (every warm session busy), or a warm turn throws, the request spills
 * to the cold runner instead of blocking on a queue — callers never fail or
 * stall just because the pool isn't ready; they only get faster when it is.
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
    if (deps.bypass?.()) {
      return deps.fallback.runDetailed(request);
    }
    const pool = select(request.purpose);
    const purpose = pool?.purpose ?? request.purpose ?? GENERAL_PURPOSE;
    deps.demand?.begin(purpose);
    try {
      // `ready()` is idle>0 and is claimed synchronously by the warm turn before
      // any await, so a ready pool never queues: overflow past `size` concurrent
      // turns falls through to the cold path below.
      if (pool && pool.ready()) {
        try {
          return await pool.runDetailed(request);
        } catch (error) {
          deps.onFallback?.(pool.purpose, error);
        }
      }
      return await deps.fallback.runDetailed(request);
    } finally {
      deps.demand?.end(purpose);
    }
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
  /**
   * Model powering warm sessions, when known. All warm sessions in every pool
   * share the CLI's configured model, so it is reported once at the top level.
   */
  model?: string;
  pools: Array<
    { purpose: string; suggestedSize: number } & MetaSessionPoolStats
  >;
}

/** Builds a live status snapshot from the configured purpose pools. */
export function metaPoolsStatus(
  enabled: boolean,
  pools: readonly Pick<PurposePool, 'purpose' | 'stats'>[],
  demand?: Pick<PoolDemand, 'suggestion'>,
  model?: string,
): MetaPoolsStatus {
  return {
    enabled,
    ...(model === undefined ? {} : { model }),
    pools: pools.map((pool) => {
      const stats = pool.stats();
      return {
        purpose: pool.purpose,
        suggestedSize: demand?.suggestion(pool.purpose) ?? stats.size,
        ...stats,
      };
    }),
  };
}
