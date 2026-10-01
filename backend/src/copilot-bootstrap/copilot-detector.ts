/**
 * Synchronous detector for whether the GitHub Copilot CLI is installed. It
 * resolves the configured executable against PATH through an injected resolver
 * so it stays decoupled from the filesystem and fully unit-testable. The
 * resolver returns a concrete existing path, or null when the command cannot be
 * found.
 */
export interface CopilotDetectorDeps {
  /** Executable name or absolute path of the Copilot CLI (e.g. `copilot`). */
  executable: string;
  /**
   * Resolves a command to a concrete, existing executable path, or null when it
   * is not installed. Recomputed on each probe so a CLI installed *during* this
   * app run is detected on the next status check without a restart.
   */
  resolve: (command: string) => string | null;
}

export type CopilotDetector = () => boolean;

/** Builds a detector that reports installed when the executable resolves. */
export function createCopilotDetector(deps: CopilotDetectorDeps): CopilotDetector {
  return () => deps.resolve(deps.executable) !== null;
}
