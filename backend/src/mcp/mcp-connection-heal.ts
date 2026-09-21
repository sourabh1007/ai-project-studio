import type { McpHealAttempt } from './mcp-contract.js';

/** The result of one live probe of an MCP server connection. */
export type McpProbeOutcome =
  | { kind: 'connected'; toolCount: number }
  | { kind: 'auth-required'; authUrl: string | null; message: string | null }
  | { kind: 'error'; message: string | null; output: string[] };

export interface McpHealDeps {
  /** Runs one live probe of the server. Re-invoked on each retry. */
  probe: () => Promise<McpProbeOutcome>;
  /**
   * Best-effort agentic remediation, run after the retries are exhausted and
   * before {@link diagnose}. It is given the failure output and is expected to
   * follow the fix the error itself prescribes (for example running the command
   * the error suggests, resolving a missing tool, or creating a missing path)
   * and to return a short report of what it did — or null when it could not act.
   * When it returns a report the connection is re-probed to confirm recovery.
   */
  remediate?: (message: string | null, output: string[]) => Promise<string | null>;
  /**
   * Best-effort AI explanation of a persistent failure, run only after the
   * automatic retries (and any {@link remediate} attempt) are exhausted.
   * Returns a short human-readable cause/fix, or null when a diagnosis could
   * not be produced.
   */
  diagnose?: (message: string | null, output: string[]) => Promise<string | null>;
  /** How many extra probes to attempt after the first failure. Default 1. */
  retries?: number;
}

export interface McpHealResult {
  /** The final probe outcome after any self-heal retries. */
  outcome: McpProbeOutcome;
  /** The ordered steps that were attempted; empty when the first probe worked. */
  attempts: McpHealAttempt[];
}

const NO_MESSAGE = 'The server exited before tool discovery completed.';

function errorDetail(message: string | null): string {
  return message ?? NO_MESSAGE;
}

async function safeText(
  run: (message: string | null, output: string[]) => Promise<string | null>,
  message: string | null,
  output: string[],
): Promise<string | null> {
  try {
    const text = await run(message, output);
    const trimmed = text?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Wraps an MCP connection probe with automatic self-healing: on a plain
 * connection error it re-probes (many stdio servers are flaky on a cold
 * `npx`/download start); when the retries still fail it runs a best-effort
 * agentic remediation that follows the fix the error itself prescribes and
 * re-probes to confirm recovery; and when that still fails it falls back to a
 * best-effort AI diagnosis. Every step is recorded in
 * {@link McpHealResult.attempts} so the caller can show the user exactly what
 * was tried. Auth-required and connected outcomes short-circuit immediately —
 * they are not faults to heal.
 */
export async function healMcpConnection(
  deps: McpHealDeps,
): Promise<McpHealResult> {
  const retries = deps.retries ?? 1;
  const attempts: McpHealAttempt[] = [];
  let outcome = await deps.probe();
  if (outcome.kind !== 'error') {
    return { outcome, attempts };
  }
  attempts.push({
    action: 'Probed the live server connection',
    outcome: 'failed',
    detail: errorDetail(outcome.message),
  });
  for (let i = 0; i < retries; i += 1) {
    outcome = await deps.probe();
    if (outcome.kind !== 'error') {
      attempts.push({
        action: 'Retried the connection',
        outcome: 'recovered',
        detail: null,
      });
      return { outcome, attempts };
    }
    attempts.push({
      action: 'Retried the connection',
      outcome: 'failed',
      detail: errorDetail(outcome.message),
    });
  }
  if (deps.remediate) {
    const report = await safeText(deps.remediate, outcome.message, outcome.output);
    attempts.push({
      action: "Followed the fix the error described",
      outcome: report ? 'info' : 'failed',
      detail: report ?? 'The self-healing agent could not act on the error.',
    });
    if (report) {
      outcome = await deps.probe();
      if (outcome.kind !== 'error') {
        attempts.push({
          action: 'Re-checked the connection after the fix',
          outcome: 'recovered',
          detail: null,
        });
        return { outcome, attempts };
      }
      attempts.push({
        action: 'Re-checked the connection after the fix',
        outcome: 'failed',
        detail: errorDetail(outcome.message),
      });
    }
  }
  const diagnosis = deps.diagnose
    ? await safeText(deps.diagnose, outcome.message, outcome.output)
    : null;
  attempts.push({
    action: 'Ran an AI self-healing diagnosis',
    outcome: diagnosis ? 'info' : 'failed',
    detail: diagnosis ?? 'The self-healing diagnosis was unavailable.',
  });
  return { outcome, attempts };
}
