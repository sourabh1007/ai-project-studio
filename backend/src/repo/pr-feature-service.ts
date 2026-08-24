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
import type { PrReview } from '../pr-review/pr-review-contract.js';
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
  features: Pick<FeatureService, 'create' | 'get'>;
  /** Kicks off the automated AI review for the new PR feature. */
  reviews: Pick<PrReviewService, 'start' | 'findByPull' | 'find' | 'refresh'>;
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
  /**
   * Re-fetches the pull request from its remote and rebuilds the review against
   * the latest head — the "take the latest / rebase the remote branch" action.
   * The PR's worktree is re-provisioned (a fresh `origin` fetch + hard checkout
   * of the current head), then the whole review pipeline is re-run so the change
   * graph and diffs reflect the newest commits. Returns the reset review whose
   * steps then repopulate asynchronously.
   */
  pullLatest(featureId: string): Promise<PrReview>;
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
      // Opening a PR that already has a review must not create a duplicate: reuse
      // its existing review feature (and its checked-out worktree) instead.
      const existingFeatureId = deps.reviews.findByPull(repo.id, number);
      if (existingFeatureId) {
        return deps.features.get(existingFeatureId);
      }
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
        // The PR's own target branch is the correct diff base; fall back to the
        // repository default only when the provider didn't report one. Using the
        // repo default alone breaks reviews of PRs that target a non-default
        // branch, and yields an empty diff when the default branch is unknown.
        baseBranch: pull.targetBranch ?? repo.defaultBranch ?? null,
      });
      return feature;
    },

    async pullLatest(featureId) {
      const review = deps.reviews.find(featureId);
      if (!review) {
        throw new NotFoundError(`Code review is not available: ${featureId}`);
      }
      const repo = deps.repos.get(review.repoId);
      const pull = await deps.getPull(repo, review.pull.number);
      if (!pull) {
        throw new NotFoundError(
          `Pull request #${review.pull.number} not found in ${repo.name}`,
        );
      }
      // Re-provisioning does a fresh `origin` fetch and hard checkout of the
      // current head, so the worktree the review reruns against is the latest
      // remote state. The refresh then rebuilds every step from that worktree.
      await deps.provisionWorktree(repo, pull);
      return deps.reviews.refresh(featureId);
    },
  };
}
