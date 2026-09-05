/** Read-side contracts for the signed-in Copilot plan's AI-credit quota. */

/**
 * A snapshot of the account's AI-credit budget as shown by the Copilot CLI
 * `/usage` panel: how much of the monthly allowance has been consumed, the
 * total allowance, and when it resets. All AIC figures are whole AI credits
 * (not nano). Values the CLI does not surface are left `null`.
 */
export interface PlanUsage {
  /** Percentage of the allowance consumed (0-100), as reported by the CLI. */
  percentUsed: number;
  /** AI credits consumed this billing period. */
  usedAic: number;
  /** Total AI credits granted for the billing period. */
  totalAic: number;
  /** AI credits still available (`totalAic - usedAic`, never below zero). */
  availableAic: number;
  /** Days until the allowance resets, when the CLI reports it. */
  resetInDays: number | null;
  /** AI credits spent in the probe's own session, when reported. */
  sessionAic: number | null;
  /** ISO timestamp of when this snapshot was captured. */
  capturedAt: string;
}

/**
 * Port that yields the raw text of the Copilot CLI `/usage` panel. The real
 * implementation drives a short-lived `copilot` pseudo-terminal (see
 * pty-plan-usage-probe.ts); the parser and service depend only on this port so
 * they stay fully unit-testable. Resolves to `null` when no panel text could be
 * captured (e.g. the CLI is unavailable or timed out).
 */
export interface PlanUsageProbe {
  capture(): Promise<string | null>;
}
