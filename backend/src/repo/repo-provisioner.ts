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

/**
 * Picks the meaningful failure line out of git's clone stderr. Git always emits
 * "Cloning into '<path>'..." first, even when the clone then fails, so that line
 * alone (which is what surfaced in the dialog) tells the user nothing. Prefer an
 * explicit `fatal:`/`error:` line, otherwise the last non-progress line, and
 * fall back to a generic message when git said nothing useful.
 */
export function cloneFailureMessage(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fatal = lines.filter((line) => /^(fatal|error):/i.test(line));
  const candidates = fatal.length
    ? fatal
    : lines.filter((line) => !/^Cloning into /i.test(line));
  return candidates[candidates.length - 1] ?? 'git clone failed';
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
      throw new ValidationError(cloneFailureMessage(res.stderr));
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
