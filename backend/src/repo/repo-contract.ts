/** The source-control provider a repository was selected from. */
export type RepoProvider = 'github' | 'azure-devops';

/**
 * A repository the user has chosen to work on. It is the top-level unit of the
 * workspace: features belong to a repository, and every session under a feature
 * runs inside the repository's local checkout ({@link Repository.localPath}).
 */
export interface Repository {
  id: string;
  provider: RepoProvider;
  /** Clone/remote URL (https). */
  remoteUrl: string;
  /** Display name, e.g. "owner/name" (GitHub) or "project/name" (Azure DevOps). */
  name: string;
  /** Absolute path to the local working copy sessions run in. */
  localPath: string;
  /** Default branch, when known. */
  defaultBranch: string | null;
  createdAt: string;
}

export interface CreateRepositoryInput {
  provider: RepoProvider;
  remoteUrl: string;
  name: string;
  localPath: string;
  defaultBranch?: string | null;
}
