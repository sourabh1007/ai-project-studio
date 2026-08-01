import { NotFoundError } from '../kernel/error-types.js';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Repository } from './repo-contract.js';
import type { RepoService } from './repo-service.js';
import type { RemotePullRequest } from './remote-pr-contract.js';
import type { ProvisionedWorktree } from './pr-worktree-provisioner.js';

export interface PrFeatureServiceDeps {
  repos: Pick<RepoService, 'get'>;
  /** Lists the open pull requests of a repository (provider-dispatched). */
  listPulls: (repo: Repository) => Promise<RemotePullRequest[]>;
  /** Fetches a single pull request by number (provider-dispatched). */
  getPull: (
    repo: Repository,
    number: number,
  ) => Promise<RemotePullRequest | null>;
  /** Checks the PR out into a dedicated git worktree. */
  provisionWorktree: (
    repo: Repository,
    pull: RemotePullRequest,
  ) => Promise<ProvisionedWorktree>;
  features: Pick<FeatureService, 'create'>;
}

/**
 * Turns a repository pull request into a feature to review it in. The PR branch
 * is checked out into its own git worktree, and a feature is created whose
 * sessions run there — so reviewing a PR is just working in a feature scoped to
 * the PR's code, isolated from the repository's primary checkout.
 */
export interface PrFeatureService {
  listPulls(repoId: string): Promise<RemotePullRequest[]>;
  createFromPull(repoId: string, number: number): Promise<Feature>;
}

export function createPrFeatureService(
  deps: PrFeatureServiceDeps,
): PrFeatureService {
  return {
    async listPulls(repoId) {
      const repo = deps.repos.get(repoId);
      return deps.listPulls(repo);
    },

    async createFromPull(repoId, number) {
      const repo = deps.repos.get(repoId);
      const pull = await deps.getPull(repo, number);
      if (!pull) {
        throw new NotFoundError(
          `Pull request #${number} not found in ${repo.name}`,
        );
      }
      const worktree = await deps.provisionWorktree(repo, pull);
      return deps.features.create({
        name: `PR #${pull.number}: ${pull.title}`,
        description: pull.url,
        repoId: repo.id,
        checkoutPath: worktree.worktreePath,
      });
    },
  };
}
