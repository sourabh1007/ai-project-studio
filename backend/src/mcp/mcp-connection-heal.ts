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
   * Best-effort AI explanation of a persistent failure, run only after the
   * automatic retries are exhausted. Returns a short human-readable cause/fix,
   * or null when a diagnosis could not be produced.
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

async function safeDiagnose(
  diagnose: NonNullable<McpHealDeps['diagnose']>,
  message: string | null,
  output: string[],
): Promise<string | null> {
  try {
    const text = await diagnose(message, output);
    const trimmed = text?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Wraps an MCP connection probe with automatic self-healing: on a plain
 * connection error it re-probes (many stdio servers are flaky on a cold
 * `npx`/download start), and when the retries still fail it runs a best-effort
 * AI diagnosis. Every step is recorded in {@link McpHealResult.attempts} so the
 * caller can show the user exactly what was tried. Auth-required and connected
 * outcomes short-circuit immediately — they are not faults to heal.
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
  const diagnosis = deps.diagnose
    ? await safeDiagnose(deps.diagnose, outcome.message, outcome.output)
    : null;
  attempts.push({
    action: 'Ran an AI self-healing diagnosis',
    outcome: diagnosis ? 'info' : 'failed',
    detail: diagnosis ?? 'The self-healing diagnosis was unavailable.',
  });
  return { outcome, attempts };
}
