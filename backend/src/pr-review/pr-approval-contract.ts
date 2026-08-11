import type { Repository } from '../repo/repo-contract.js';
import type { PrReviewPull } from './pr-review-contract.js';

/** Provider-agnostic result returned after approving a pull request. */
export interface PrApprovalResult {
  approved: true;
  state: 'approved';
  reviewer?: string;
  /** True when the signed-in reviewer had already approved the pull request. */
  alreadyApproved?: boolean;
}

/** Provider port bound to one pull request that can cast the reviewer approval. */
export interface PrApprovalGateway {
  approve(): Promise<PrApprovalResult>;
}

/** Resolves the provider-specific approval gateway for a repository + pull. */
export interface PrApprovalGatewayResolver {
  resolve(repo: Repository, pull: PrReviewPull): PrApprovalGateway;
}

/** Application service backing the PR review page's approve action. */
export interface PrApprovalService {
  approve(featureId: string): Promise<PrApprovalResult>;
}
