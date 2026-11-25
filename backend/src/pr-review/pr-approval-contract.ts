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
  getRevisions?(): Promise<PrReviewRevisions>;
  getHeadSha(): Promise<string>;
  approve(expectedHeadSha?: string): Promise<PrApprovalResult>;
}

/** Resolves the provider-specific approval gateway for a repository + pull. */
export interface PrApprovalGatewayResolver {
  resolve(repo: Repository, pull: PrReviewPull): PrApprovalGateway;
}

/** Application service backing the PR review page's approve action. */
export interface PrApprovalService {
  revisions?(featureId: string): Promise<PrReviewRevisions>;
  approve(featureId: string, expectedHeadSha?: string, expectedReviewUpdatedAt?: string,
    expectedRunId?: string, expectedAssessmentRevision?: number): Promise<PrApprovalResult>;
  status?(featureId: string): Promise<PrApprovalStatus>;
}

export interface PrReviewRevisions {
  headSha: string;
  baseSha: string;
  targetBranch: string;
}

export interface PrApprovalStatus {
  reviewedHeadSha: string | null;
  currentHeadSha: string;
  canApprove: boolean;
  reason: string | null;
}
