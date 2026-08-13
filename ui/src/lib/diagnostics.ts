/**
 * Builds a local-only diagnostics report (Phase 4e).
 *
 * Aggregates the small amount of local, non-sensitive signal the renderer can
 * see — app version, environment, current connection/health status, the log
 * directory, and recent client-side failures — into a structured, exportable
 * report. Everything here is pure: callers inject the current time so output is
 * deterministic and testable. No secrets, no network, no persistence.
 */

import type { FailureEntry } from './failure-log';

export interface DiagnosticsInput {
  /** App version from the desktop bridge, if available. */
  readonly version: string | null;
  /** Coarse platform string (e.g. navigator.platform). */
  readonly platform: string;
  /** Browser/Electron user agent. */
  readonly userAgent: string;
  /** Derived connection status label (online/backend-down/offline). */
  readonly connection: string;
  /** Backend health probe outcome ('ok' | 'unreachable' | 'unknown'). */
  readonly health: string;
  /** Local log directory path, if known. */
  readonly logDirectory: string | null;
  /** Recent recorded failures (newest first). */
  readonly failures: readonly FailureEntry[];
  /** Current time as an ISO string (injected for determinism). */
  readonly now: string;
}

export interface DiagnosticsReport {
  readonly generatedAt: string;
  readonly app: { readonly version: string };
  readonly environment: {
    readonly platform: string;
    readonly userAgent: string;
  };
  readonly status: {
    readonly connection: string;
    readonly health: string;
  };
  readonly logDirectory: string;
  readonly recentFailures: readonly FailureEntry[];
}

const PLACEHOLDER = 'unknown';

function orUnknown(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : PLACEHOLDER;
}

/** Assembles a structured diagnostics report from local signals. */
export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
  return {
    generatedAt: input.now,
    app: { version: orUnknown(input.version) },
    environment: {
      platform: orUnknown(input.platform),
      userAgent: orUnknown(input.userAgent),
    },
    status: {
      connection: orUnknown(input.connection),
      health: orUnknown(input.health),
    },
    logDirectory: orUnknown(input.logDirectory),
    recentFailures: input.failures,
  };
}

/** Serialises a diagnostics report to pretty JSON for copy/export. */
export function formatDiagnostics(report: DiagnosticsReport): string {
  return JSON.stringify(report, null, 2);
}
