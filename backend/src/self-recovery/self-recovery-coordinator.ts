/**
 * Actions the self-recovery escalation drives once a live session's in-session
 * re-submits are exhausted. All are injected so the ordering logic stays pure
 * and fully testable, and so the IO-bound pieces (a metasession, a PTY restart,
 * a status-bar report) live at the composition edges.
 */
export interface SelfRecoveryCoordinatorDeps {
  /** Whether to run a metasession diagnosis before the last-resort restart. */
  useMetaAnalysis: boolean;
  /**
   * Analyzes the failing output via a metasession and resolves a short, human
   * diagnosis (or null when it has nothing useful to add). Rejects when the
   * metasession itself cannot spin up — the signal that automatic analysis is
   * unavailable and the failure should surface to the user.
   */
  analyze?: (errorText: string) => Promise<string | null>;
  /**
   * Last-resort recovery: kill and relaunch the session's CLI in a fresh
   * conversation and replay the user's last prompt. Resolves true when the
   * restart was carried out, false when it could not be.
   */
  restart: () => Promise<boolean>;
  /** Surfaces an IDE notice inside the session's terminal (kept out of usage). */
  notify: (text: string) => void;
  /** Reports an unrecoverable failure to the status bar / bottom bar. */
  report: (message: string) => void;
}

export interface SelfRecoveryCoordinator {
  /**
   * Escalates a recoverable failure whose in-session re-submits are spent:
   * optionally analyze it via a metasession (surfacing the diagnosis), then
   * restart the session as a last resort. Only when the restart cannot be
   * carried out is the failure reported to the status bar — and the message
   * notes when automatic analysis was also unavailable.
   */
  escalate(errorText: string): Promise<void>;
}

/** Prefix on every self-recovery terminal notice, so users can spot the IDE. */
const NOTICE_PREFIX = '[self-recovery]';

/**
 * Pure orchestrator for the "restart as a fallback" recovery ladder. The
 * non-destructive rung (re-submitting the last prompt) is handled upstream by
 * the session auto-retry controller; this coordinator runs only after that
 * budget is spent, layering metasession analysis and a final CLI restart on top
 * and guaranteeing the user is told when nothing automatic could recover it.
 */
export function createSelfRecoveryCoordinator(
  deps: SelfRecoveryCoordinatorDeps,
): SelfRecoveryCoordinator {
  return {
    async escalate(errorText) {
      let analysisUnavailable = false;

      if (deps.useMetaAnalysis && deps.analyze) {
        try {
          const diagnosis = await deps.analyze(errorText);
          const trimmed = diagnosis?.trim();
          if (trimmed) {
            deps.notify(`\r\n${NOTICE_PREFIX} ${trimmed}\r\n`);
          }
        } catch {
          // The metasession could not spin up: automatic analysis is
          // unavailable. Still attempt the restart, but remember to say so if
          // even that cannot recover the session.
          analysisUnavailable = true;
        }
      }

      deps.notify(
        `\r\n${NOTICE_PREFIX} recovering session — restarting the CLI…\r\n`,
      );

      let restarted = false;
      try {
        restarted = await deps.restart();
      } catch {
        restarted = false;
      }

      if (restarted) {
        return;
      }

      deps.report(
        analysisUnavailable
          ? 'Automatic recovery failed and the analysis session could not start. Restart the session to continue.'
          : 'Automatic recovery failed. Restart the session to continue.',
      );
    },
  };
}
