import type { RepoProvider } from './repo-contract.js';

/**
 * A repository available to pick from a provider (GitHub / Azure DevOps) that
 * the user has not necessarily added to the workspace yet. Selecting one either
 * clones it or points at an existing local checkout, producing a
 * {@link Repository}.
 */
export interface RemoteRepo {
  provider: RepoProvider;
  /** Display name, e.g. "owner/name" (GitHub) or "project/name" (Azure DevOps). */
  name: string;
  /** HTTPS clone URL. */
  remoteUrl: string;
  /** Default branch, when known. */
  defaultBranch: string | null;
}
