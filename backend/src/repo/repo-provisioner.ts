import { ValidationError } from '../kernel/error-types.js';
import type { CreateRepositoryInput, RepoProvider } from './repo-contract.js';

export interface CloneRequest {
  remoteUrl: string;
  targetPath: string;
}

/** Runs `git clone <remoteUrl> <targetPath>`; resolves on success. */
export type GitCloneRunner = (
  request: CloneRequest,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface RepoProvisionerDeps {
  clone: GitCloneRunner;
  /** Whether a directory already exists on disk. */
  pathExists: (path: string) => boolean;
}

export interface ProvisionRepoInput {
  provider: RepoProvider;
  remoteUrl: string;
  name: string;
  defaultBranch?: string | null;
  /** Target checkout path: cloned into (clone) or validated (existing). */
  localPath: string;
  /** Whether to clone the repo or attach to an existing local checkout. */
  mode: 'clone' | 'existing';
}

/**
 * Turns a repo-selection request into a {@link CreateRepositoryInput}, either by
 * cloning the remote into the given path or by validating an existing local
 * checkout. Both the clone runner and the filesystem check are injected so this
 * stays pure and unit-tested; the real runners are wired in main.ts.
 */
export async function provisionRepo(
  deps: RepoProvisionerDeps,
  input: ProvisionRepoInput,
): Promise<CreateRepositoryInput> {
  const localPath = input.localPath.trim();
  if (!localPath) {
    throw new ValidationError('A local path is required');
  }

  if (input.mode === 'clone') {
    if (deps.pathExists(localPath)) {
      throw new ValidationError(
        `Target path already exists: ${localPath}. Choose an empty path or attach it as an existing checkout.`,
      );
    }
    const res = await deps.clone({
      remoteUrl: input.remoteUrl,
      targetPath: localPath,
    });
    if (res.code !== 0) {
      throw new ValidationError(res.stderr.trim() || 'git clone failed');
    }
  } else if (!deps.pathExists(localPath)) {
    throw new ValidationError(`Path does not exist: ${localPath}`);
  }

  return {
    provider: input.provider,
    remoteUrl: input.remoteUrl,
    name: input.name,
    localPath,
    defaultBranch: input.defaultBranch ?? null,
  };
}
