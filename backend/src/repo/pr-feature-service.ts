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
  features: Pick<FeatureService, 'create' | 'get' | 'setCheckoutPath'>;
  /** Kicks off the automated AI review for the new PR feature. */
  reviews: Pick<PrReviewService, 'start' | 'findByPull' | 'find' | 'refresh'>;
  /**
   * Optional: notified once, with the new feature id, right after a PR review
   * feature is created. Wired in `main.ts` to auto-attach the Review Board
   * agent so imported PRs get it by default (and remain detachable).
   */
  onReviewFeatureCreated?: (featureId: string) => void;
}

/**
 * Turns a repository pull request into a feature to review it in. The PR branch
 * is checked out into its own git worktree, and a feature is created whose
 * sessions run there — so reviewing a PR is just working in a feature scoped to
 * the PR's code, isolated from the repository's primary checkout.
 */
export interface PrFeatureService {
  listPulls(repoId: string, filter?: PullFilter): Promise<RemotePullRequest[]>;
  createFromPull(
    repoId: string,
    number: number,
    parentFeatureId?: string | null,
    parentGroupId?: string | null,
  ): Promise<Feature>;
  /**
   * Converts an existing (non-PR) feature into a PR feature in place: checks the
   * pull request out into its own worktree, repoints the feature's sessions
   * there, and starts the review — making the feature Review-Board-eligible
   * without creating a separate child feature. Any agent state already attached
   * to the feature (e.g. a New Task run) is preserved because the feature id is
   * unchanged. Idempotent: a feature that already has a review is returned as-is.
   */
  convertToPrFeature(
    repoId: string,
    number: number,
    featureId: string,
  ): Promise<Feature>;
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

    async createFromPull(repoId, number, parentFeatureId = null, parentGroupId = null) {
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
        // Nest the review under the feature it was opened from, when any, so it
        // renders as a child rather than a sibling in the explorer tree. When a
        // subcategory group is given instead, the review lands inside it (the
        // two are mutually exclusive).
        parentFeatureId: parentGroupId ? null : parentFeatureId,
        parentGroupId,
      });
      deps.reviews.start({
        featureId: feature.id,
        repoId: repo.id,
        pull,
        worktreePath: worktree.worktreePath,
        headSha: worktree.headSha,
        // The PR's own target branch is the correct diff base; fall back to the
        // repository default only when the provider didn't report one. Using the
        // repo default alone breaks reviews of PRs that target a non-default
        // branch, and yields an empty diff when the default branch is unknown.
        baseBranch: pull.targetBranch ?? repo.defaultBranch ?? null,
      });
      deps.onReviewFeatureCreated?.(feature.id);
      return feature;
    },

    async convertToPrFeature(repoId, number, featureId) {
      const repo = deps.repos.get(repoId);
      const feature = deps.features.get(featureId);
      // Idempotent: if this feature is already a PR feature, keep its review and
      // worktree rather than provisioning a duplicate.
      if (deps.reviews.find(featureId)) {
        return feature;
      }
      const pull = await deps.getPull(repo, number);
      if (!pull) {
        throw new NotFoundError(
          `Pull request #${number} not found in ${repo.name}`,
        );
      }
      const worktree = await deps.provisionWorktree(repo, pull);
      // Repoint the same feature's sessions onto the PR worktree so it behaves
      // like any other PR feature, without changing its id (which preserves the
      // attached New Task run and any other agent state).
      const converted = deps.features.setCheckoutPath(
        featureId,
        worktree.worktreePath,
      );
      deps.reviews.start({
        featureId,
        repoId: repo.id,
        pull,
        worktreePath: worktree.worktreePath,
        headSha: worktree.headSha,
        baseBranch: pull.targetBranch ?? repo.defaultBranch ?? null,
      });
      deps.onReviewFeatureCreated?.(featureId);
      return converted;
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
      // remote state. The refresh then rebuilds every step from that worktree,
      // recording the new head SHA so the board shows the commit under review.
      const worktree = await deps.provisionWorktree(repo, pull);
      return deps.reviews.refresh(featureId, worktree.headSha);
    },
  };
}
