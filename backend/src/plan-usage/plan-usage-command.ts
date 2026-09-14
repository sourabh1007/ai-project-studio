import { AGENCY_NAMESPACE } from '../provider/agency-adapter/config.js';

/** A resolved executable + argument vector for the plan-usage probe. */
export interface PlanUsageProbeCommand {
  command: string;
  args: string[];
}

export interface PlanUsageCommandInput {
  /** Active meta provider id (e.g. `'copilot'` or `'agency'`). */
  providerId: string;
  /**
   * Model the throwaway TUI is pinned to, avoiding a blocking first-run model
   * picker. Any valid model works; the session never sends a prompt.
   */
  model: string;
  /**
   * Mandatory UUID `--session-id`. The Copilot CLI shim refuses to launch its
   * interactive TUI without one, so `/usage` would never render.
   */
  sessionId: string;
  /** Copilot CLI executable name/path (resolved by the spawner). */
  copilot: { executable: string };
  /** Agency CLI executable + the Copilot subcommand it forwards to. */
  agency: { executable: string; subcommand: string };
}

/**
 * Builds the interactive command that boots a throwaway provider TUI for the
 * `/usage` scrape, reflecting the *active* provider so the quota shown matches
 * the account actually doing work.
 *
 * Agency merely wraps the Copilot CLI (`agency <subcommand> -- <copilot flags>`)
 * and exposes no quota of its own, so its `/usage` panel is the same underlying
 * budget — but launching through Agency uses Agency's own executable resolution
 * and environment, which is what a user on the Agency provider expects. Any
 * non-Agency provider uses the plain Copilot form.
 */
export function buildPlanUsageProbeCommand(
  input: PlanUsageCommandInput,
): PlanUsageProbeCommand {
  const copilotArgs = ['--model', input.model, '--session-id', input.sessionId];
  if (input.providerId === AGENCY_NAMESPACE) {
    return {
      command: input.agency.executable,
      args: [input.agency.subcommand, '--', ...copilotArgs],
    };
  }
  return { command: input.copilot.executable, args: copilotArgs };
}
