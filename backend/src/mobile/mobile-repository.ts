import { ProviderError, ValidationError } from '../kernel/error-types.js';
import type { Repository } from '../repo/repo-contract.js';

export interface MobileRepositoryDeps {
  list(): Repository[];
  gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  git(args: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }>;
  pathFor(name: string): string;
  pathExists(path: string): boolean;
  create(input: Omit<Repository, 'id' | 'createdAt'>): Repository;
}

export async function importMobileRepository(deps: MobileRepositoryDeps, name: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name) || /\/\.{1,2}$/.test(name)) {
    throw new ValidationError('Enter a GitHub owner/repository name, not a URL or local path.');
  }
  const existing = deps.list().find((repo) => repo.provider === 'github' && repo.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (!existing.defaultBranch || !deps.pathExists(existing.localPath)) {
      throw new ValidationError('This repository is already registered but its checkout or default branch needs repair on the host.');
    }
    return { ...existing, defaultBranch: existing.defaultBranch };
  }
  const remote = await deps.gh(['repo', 'view', name, '--json', 'nameWithOwner,defaultBranchRef']);
  if (remote.code !== 0) throw new ProviderError(remote.stderr.trim() || 'GitHub repository lookup failed.');
  const metadata: unknown = JSON.parse(remote.stdout);
  if (!metadata || typeof metadata !== 'object' ||
      !('nameWithOwner' in metadata) || typeof metadata.nameWithOwner !== 'string' ||
      metadata.nameWithOwner.toLowerCase() !== name.toLowerCase() ||
      !('defaultBranchRef' in metadata) || !metadata.defaultBranchRef ||
      typeof metadata.defaultBranchRef !== 'object' ||
      !('name' in metadata.defaultBranchRef) || typeof metadata.defaultBranchRef.name !== 'string' ||
      !metadata.defaultBranchRef.name) {
    throw new ProviderError('GitHub did not return a matching repository and default branch. Empty repositories need an initial commit first.');
  }
  const canonicalName = metadata.nameWithOwner;
  const remoteUrl = `https://github.com/${canonicalName}.git`;
  const localPath = deps.pathFor(canonicalName);
  const git = async (args: string[]): Promise<string> => {
    signal.throwIfAborted();
    const result = await deps.git(args, signal);
    if (result.code !== 0) throw new ProviderError(result.stderr.trim() || 'GitHub checkout failed.');
    return result.stdout.trim();
  };
  if (deps.pathExists(localPath)) {
    const origin = await git(['-C', localPath, 'remote', 'get-url', 'origin']);
    if (origin !== remoteUrl) throw new ValidationError('The import directory already exists with a different origin. No files were overwritten.');
    await git(['-C', localPath, 'rev-parse', '--verify', 'HEAD^{commit}']);
  } else {
    await git(['clone', '--', remoteUrl, localPath]);
  }
  signal.throwIfAborted();
  const repository = deps.create({
    provider: 'github', name: canonicalName, remoteUrl, localPath, defaultBranch: metadata.defaultBranchRef.name,
  });
  return { ...repository, defaultBranch: metadata.defaultBranchRef.name };
}
