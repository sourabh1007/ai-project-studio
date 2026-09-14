import { MetaAbortError, type MetaRequest, type MetaRunResult, type MetaRunner } from './meta-runner.js';
import { AcpRequestError } from './acp/acp-client.js';
import type { MetaSessionPoolStats } from './acp/acp-pool.js';
import type { PoolDemand, PoolDemandPort } from './pool-demand.js';
import type { MetaOperationPhysicalRegistration } from './meta-operation-contract.js';
import { registerUnstartedMetaAttempt } from './meta-operation-physical-ownership.js';

/**
 * The single warm pool. Every meta AI turn leases from it, so warm capacity is
 * one shared resource rather than something to partition per workflow.
 */
export interface WarmPool {
  /** Live warm-capacity snapshot for status surfaces and routing. */
  stats(): MetaSessionPoolStats;
  /** Runs a single turn on a warm session, waiting for one to free if needed. */
  runDetailed(request: MetaRequest): Promise<MetaRunResult>;
}

export interface PooledMetaRunnerDeps {
  physicalOwnership?: MetaOperationPhysicalRegistration;
  /** The shared warm pool every request leases from. */
  pool: WarmPool;
  /** Cold runner used while the pool warms up or when a warm turn fails pre-dispatch. */
  fallback: MetaRunner;
  /** Default request timeout budget when the caller did not set one. */
  defaultTimeoutMs: number;
  /** Logs a warm-turn failure before falling back (optional). */
  onFallback?: (error: unknown) => void;
  /**
   * When it returns `true` the warm pools are skipped entirely and the request
   * runs on the cold {@link fallback}. Used to honor a runtime model override:
   * warm ACP sessions are pinned to the CLI's default model, so a request that
   * needs a specific model must take the cold path where the model is applied.
   */
  bypass?: () => boolean;
  /** True when the warm ACP path can honor this request's exact constraints. */
  supportsWarm?: (request: MetaRequest) => boolean;
  /**
   * Optional demand telemetry. Every routed turn (warm or spilled to cold) is
   * counted so the Settings page can suggest a warm size from observed peak
   * concurrency.
   */
  demand?: PoolDemandPort;
}

/** Purpose recorded for requests that don't name one. */
export const GENERAL_PURPOSE = 'general';

/**
 * A {@link MetaRunner} that prefers warm `copilot --acp` sessions from the one
 * shared pool and falls back to the cold runner only when no warm session
 * exists yet.
 *
 * As long as the pool has at least one *live* (booted) session, every eligible
 * turn leases from it — and when they are all busy it **waits** in the pool's
 * bounded queue for one to free rather than cold-spawning a new CLI. The wait
 * is bounded by the request's own deadline, so a saturated pool degrades to a
 * slower turn (or a surfaced timeout), never an unbounded stall or a storm of
 * cold processes. The cold runner is used only while the pool is still warming
 * from a cold start (no live sessions yet) or failed to start, so enabling the
 * pool never leaves the IDE unable to respond. Once a warm turn was actually
 * dispatched, its failure is surfaced rather than retried cold, preventing
 * duplicate provider work.
 */
export function createPooledMetaRunner(deps: PooledMetaRunnerDeps): MetaRunner {
  function canFallback(error: unknown): boolean {
    return error instanceof AcpRequestError && error.allowFallbackToCold;
  }

  async function runDetailed(request: MetaRequest): Promise<MetaRunResult> {
    if (request.signal?.aborted) {
      registerUnstartedMetaAttempt(deps.physicalOwnership, request.operationId);
      throw new MetaAbortError({
        kind: 'aborted',
        termination: 'not-started',
      });
    }
    const timeoutMs = request.timeoutMs ?? deps.defaultTimeoutMs;
    const bounded: MetaRequest = {
      ...request,
      timeoutMs,
      deadlineAt: request.deadlineAt ?? Date.now() + timeoutMs,
    };
    if (deps.bypass?.() || bounded.forceCold) {
      return deps.fallback.runDetailed(bounded);
    }
    deps.demand?.begin();
    try {
      // Route warm whenever the pool has a live session. `pool.runDetailed`
      // leases one, waiting in the pool's bounded queue (capped by the request
      // deadline) when they are all busy — so an eligible turn waits for a free
      // warm session instead of cold-spawning. Only spill to cold when the pool
      // has no live sessions yet (still warming from a cold start, or failed to
      // start), so the IDE always responds.
      if ((deps.supportsWarm?.(bounded) ?? true) && deps.pool.stats().live > 0) {
        try {
          return await deps.pool.runDetailed(bounded);
        } catch (error) {
          if (!canFallback(error)) {
            throw error;
          }
          deps.onFallback?.(error);
        }
      }
      return await deps.fallback.runDetailed(bounded);
    } finally {
      deps.demand?.end();
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
  /** Shared native headless reservations; interactive PTYs and descendants are excluded. */
  processAdmission?: {
    processes: number;
    warmProcesses: number;
    queued: number;
    closed: boolean;
    maxProcesses: number;
    maxWarmProcesses: number;
    maxQueued: number;
  };
  enabled: boolean;
  /**
   * Model powering warm sessions, when known. Every warm session shares the
   * CLI's configured model, so it is reported once at the top level.
   */
  model?: string;
  /**
   * Live capacity of the shared warm pool. Absent when warm pools are disabled.
   */
  pool?: MetaSessionPoolStats & {
    /** Warm size suggested by observed peak concurrency. */
    suggestedSize: number;
  };
}

/** Builds a live status snapshot from the shared warm pool. */
export function metaPoolsStatus(
  enabled: boolean,
  pool?: Pick<WarmPool, 'stats'>,
  demand?: Pick<PoolDemand, 'suggestion'>,
  model?: string,
): MetaPoolsStatus {
  if (!pool) {
    return { enabled, ...(model === undefined ? {} : { model }) };
  }
  const stats = pool.stats();
  return {
    enabled,
    ...(model === undefined ? {} : { model }),
    pool: { ...stats, suggestedSize: demand?.suggestion() ?? stats.size },
  };
}
