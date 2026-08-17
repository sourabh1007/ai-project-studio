import type { Repository } from '../repo/repo-contract.js';
import type { PrReviewPull } from './pr-review-contract.js';

/** Provider-agnostic result returned after writing the review into a PR body. */
export interface PrDescriptionResult {
  updated: true;
  /** Web URL of the pull request whose description was updated. */
  url: string;
}

/**
 * Provider port bound to one pull request that can read and overwrite its
 * description/body. Implemented by thin GitHub (`gh`) and Azure DevOps (REST)
 * adapters.
 */
export interface PrDescriptionGateway {
  /** The PR's current description/body (empty string when it has none). */
  getBody(): Promise<string>;
  /** Overwrites the PR's description/body with `body`. */
  setBody(body: string): Promise<void>;
}

/** Resolves the provider-specific description gateway for a repository + pull. */
export interface PrDescriptionGatewayResolver {
  resolve(repo: Repository, pull: PrReviewPull): PrDescriptionGateway;
}

/**
 * Application service backing the PR review page's "add to PR description"
 * action: it writes the review's problem statement and change-graph diagram into
 * the pull request's own description as a managed, idempotent Markdown block.
 */
export interface PrDescriptionService {
  exportToPull(featureId: string): Promise<PrDescriptionResult>;
}
