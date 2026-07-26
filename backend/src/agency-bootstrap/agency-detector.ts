/**
 * Synchronous detector for whether the `agency` CLI is installed. It probes a
 * set of candidate install paths via an injected existence check so it stays
 * decoupled from the filesystem and fully unit-testable.
 */
export interface AgencyDetectorDeps {
  paths: string[];
  pathExists: (path: string) => boolean;
}

export type AgencyDetector = () => boolean;

/** Builds a detector that reports installed when any candidate path exists. */
export function createAgencyDetector(deps: AgencyDetectorDeps): AgencyDetector {
  return () => deps.paths.some((path) => deps.pathExists(path));
}
