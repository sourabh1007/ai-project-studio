import type {
  HealthCheckResult,
  HealthProbe,
  HealthProbeOutcome,
  HealthReportService,
  HealthState,
  ProviderHealth,
  SystemHealthReport,
} from './health-contract.js';

export interface HealthReportServiceDeps {
  /** The subsystem probes to run on every report. */
  probes: readonly HealthProbe[];
  /** Snapshot of each configured AI provider's install/version health. */
  providerHealth: () => ProviderHealth[] | Promise<ProviderHealth[]>;
  /** Per-probe timeout; a slower probe is reported as `down`. */
  timeoutMs: number;
  /** Monotonic-ish clock in milliseconds; injectable for deterministic tests. */
  now?: () => number;
}

/** Ordering used to fold many states into the single worst one. */
const SEVERITY: Record<HealthState, number> = { ok: 0, degraded: 1, down: 2 };

/** The worst (most severe) state in the list; `ok` when the list is empty. */
function worstState(states: readonly HealthState[]): HealthState {
  return states.reduce<HealthState>(
    (acc, state) => (SEVERITY[state] > SEVERITY[acc] ? state : acc),
    'ok',
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Aggregates the registered subsystem probes and provider-health snapshot into
 * one {@link SystemHealthReport}. Every probe is bounded by `timeoutMs` and can
 * never throw out of the report: a rejection becomes `down` with the error
 * message, a timeout becomes `down` with a "timed out" detail. Probes run
 * concurrently so one slow subsystem doesn't serialize the rest.
 */
export function createHealthReportService(
  deps: HealthReportServiceDeps,
): HealthReportService {
  const now = deps.now ?? (() => Date.now());

  async function runProbe(probe: HealthProbe): Promise<HealthCheckResult> {
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HealthProbeOutcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            state: 'down',
            detail: `Timed out after ${deps.timeoutMs}ms`,
          }),
        deps.timeoutMs,
      );
    });
    // A rejection is folded into a `down` outcome rather than thrown, so the
    // race below always resolves and a probe can never break the whole report.
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => probe.check())
        .catch(
          (error): HealthProbeOutcome => ({
            state: 'down',
            detail: errorText(error),
          }),
        ),
      timeout,
    ]);
    clearTimeout(timer);
    return {
      id: probe.id,
      title: probe.title,
      state: outcome.state,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      latencyMs: Math.max(0, now() - startedAt),
    };
  }

  return {
    async report(): Promise<SystemHealthReport> {
      const [checks, providers] = await Promise.all([
        Promise.all(deps.probes.map(runProbe)),
        Promise.resolve(deps.providerHealth()),
      ]);
      return {
        generatedAt: now(),
        overall: worstState(checks.map((check) => check.state)),
        checks,
        providers,
      };
    },
  };
}
