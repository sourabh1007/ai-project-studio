import { NotFoundError } from '../kernel/error-types.js';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Repository } from './repo-contract.js';
import type { RepoService } from './repo-service.js';
import type {
  RemotePullRequest,
  PullFilter,
} from './remote-pr-contract.js';
import type { ProvisionedWorktree } from './pr-worktree-provisioner.js';
import type { PrReviewService } from '../pr-review/pr-review-service.js';

export interface PrFeatureServiceDeps {
  repos: Pick<RepoService, 'get'>;
  /** Lists a subset of a repository's open pull requests (provider-dispatched). */
  listPulls: (
    repo: Repository,
    filter: PullFilter,
  ) => Promise<RemotePullRequest[]>;
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
  /** Kicks off the automated AI review for the new PR feature. */
  reviews: Pick<PrReviewService, 'start'>;
}

/**
 * Turns a repository pull request into a feature to review it in. The PR branch
 * is checked out into its own git worktree, and a feature is created whose
 * sessions run there — so reviewing a PR is just working in a feature scoped to
 * the PR's code, isolated from the repository's primary checkout.
 */
export interface PrFeatureService {
  listPulls(repoId: string, filter?: PullFilter): Promise<RemotePullRequest[]>;
  createFromPull(repoId: string, number: number): Promise<Feature>;
}

export function createPrFeatureService(
  deps: PrFeatureServiceDeps,
): PrFeatureService {
  return {
    async listPulls(repoId, filter = 'all') {
      const repo = deps.repos.get(repoId);
      return deps.listPulls(repo, filter);
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
      const feature = await deps.features.create({
        name: `PR #${pull.number}: ${pull.title}`,
        description: pull.url,
        repoId: repo.id,
        checkoutPath: worktree.worktreePath,
      });
      deps.reviews.start({
        featureId: feature.id,
        repoId: repo.id,
        pull,
        worktreePath: worktree.worktreePath,
        baseBranch: repo.defaultBranch ?? null,
      });
      return feature;
    },
  };
}
