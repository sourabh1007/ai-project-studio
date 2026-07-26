/**
 * Synchronous detector for whether the `agency` CLI is installed. It probes a
 * set of candidate install paths via an injected existence check so it stays
 * decoupled from the filesystem and fully unit-testable.
 */
export interface AgencyDetectorDeps {
  /**
   * Candidate install paths, recomputed on each probe. A thunk (rather than a
   * fixed array) so a version installed *during* this app run — into a brand-new
   * versioned folder — is detected on the next status check without a restart.
   */
  paths: () => string[];
  pathExists: (path: string) => boolean;
}

export type AgencyDetector = () => boolean;

/** Builds a detector that reports installed when any candidate path exists. */
export function createAgencyDetector(deps: AgencyDetectorDeps): AgencyDetector {
  return () => deps.paths().some((path) => deps.pathExists(path));
}
