/**
 * System-health domain contract. The IDE exposes a single aggregated view of
 * whether its own backend API surfaces and each configured AI provider are
 * healthy, so a user can tell at a glance if "something is down" and recover it.
 *
 * A {@link HealthProbe} is a thin, injectable check over one backend subsystem
 * (persistence, providers, configuration, …); the {@link HealthReportService}
 * runs them all — bounded by a timeout, never throwing — and folds the results
 * into one {@link SystemHealthReport}. Provider install/version state is reported
 * alongside as its own section.
 *
 * Type-only module (no runtime code) so it stays free of the coverage gate.
 */

/** Health of a single subsystem or the system overall. */
export type HealthState = 'ok' | 'degraded' | 'down';

/** What a probe reports about the subsystem it checks. */
export interface HealthProbeOutcome {
  state: HealthState;
  /** One-line human explanation, shown when not `ok` (or for extra context). */
  detail?: string;
}

/** A single, bounded check over one backend subsystem. */
export interface HealthProbe {
  /** Stable id used by the UI (e.g. `persistence`). */
  id: string;
  /** Human title (e.g. `Persistence (database)`). */
  title: string;
  /**
   * Run the check. May be async. Should be cheap and side-effect-free. Throwing
   * (or exceeding the service timeout) is treated as `down` by the service.
   */
  check: () => Promise<HealthProbeOutcome> | HealthProbeOutcome;
}

/** The resolved result of running one {@link HealthProbe}. */
export interface HealthCheckResult {
  id: string;
  title: string;
  state: HealthState;
  detail?: string;
  /** Wall-clock time the probe took, in milliseconds. */
  latencyMs: number;
}

/** Install/version health for one configured AI provider. */
export interface ProviderHealth {
  /** Provider id (e.g. `copilot`, `agency`). */
  id: string;
  /** Human title (e.g. `GitHub Copilot CLI`). */
  title: string;
  /** Whether the provider's CLI is installed right now. */
  installed: boolean;
  /** Installed version when known. */
  version?: string | null;
  /** Current background auto-upgrade phase, when the provider reports one. */
  upgradePhase?: string;
  /** One-line human explanation (e.g. why it is not installed). */
  detail?: string;
}

/** Aggregated system-health snapshot returned by `GET /system-health`. */
export interface SystemHealthReport {
  /** Epoch milliseconds the report was generated. */
  generatedAt: number;
  /** Worst state across all subsystem checks. */
  overall: HealthState;
  /** One entry per backend subsystem probe. */
  checks: HealthCheckResult[];
  /** One entry per configured AI provider. */
  providers: ProviderHealth[];
}

/** Aggregates the registered probes + provider health into one report. */
export interface HealthReportService {
  /** Run every probe (bounded, never throwing) and build the report. */
  report(): Promise<SystemHealthReport>;
}
