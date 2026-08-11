import { ProviderError } from '../kernel/error-types.js';
import type {
  AzureHttpGetter,
  AzureHttpPutter,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import type { AzureUserIdentity } from './azure-pr-lister.js';
import {
  connectionDataUrl,
  fetchAzureUser,
  parseAuthenticatedUser,
} from './azure-pr-lister.js';
import type {
  PrApprovalGateway,
  PrApprovalResult,
} from '../pr-review/pr-approval-contract.js';
import type { AzurePrTarget } from './azure-pr-comments.js';

const API_VERSION = '7.1';

/** Azure DevOps reviewer vote value that represents a full approval. */
export const APPROVED_VOTE = 10;

/** The deps an Azure approval gateway needs: auth, identity lookup, and PUT. */
export interface AzureApprovalDeps {
  token: AzureTokenGetter;
  httpGet: AzureHttpGetter;
  httpPut: AzureHttpPutter;
}

/** REST URL that creates/updates the current user's reviewer vote. */
export function reviewerVoteUrl(
  target: AzurePrTarget,
  reviewerId: string,
): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/git/repositories` +
    `/${encodeURIComponent(target.repo)}/pullRequests` +
    `/${target.pullRequestId}/reviewers/${encodeURIComponent(reviewerId)}` +
    `?api-version=${API_VERSION}`
  );
}

/** REST URL for a single pull request (used to read its reviewers + votes). */
export function pullDetailUrl(target: AzurePrTarget): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/git/repositories` +
    `/${encodeURIComponent(target.repo)}/pullRequests` +
    `/${target.pullRequestId}?api-version=${API_VERSION}`
  );
}

/** The request body Azure DevOps uses for an approval vote. */
export function approvalVoteBody(): unknown {
  return { vote: APPROVED_VOTE };
}

/** One reviewer entry as returned on an Azure DevOps pull request. */
export interface AzureReviewerVote {
  id: string;
  uniqueName: string | null;
  vote: number;
}

interface AdoReviewer {
  id?: unknown;
  uniqueName?: unknown;
  vote?: unknown;
}

/**
 * Finds the signed-in user among a pull request's reviewers, returning the
 * reviewer id in the *correct identity namespace* (the profile id from the
 * account endpoint is a different id that the reviewer-vote endpoint rejects
 * with HTTP 400) plus their current vote — so the caller can both target the
 * right identity and detect an existing approval.
 */
export function findMyReviewer(
  body: unknown,
  me: AzureUserIdentity | null,
): AzureReviewerVote | null {
  const reviewers = (body as { reviewers?: unknown })?.reviewers;
  if (!Array.isArray(reviewers) || !me) {
    return null;
  }
  for (const raw of reviewers as AdoReviewer[]) {
    const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
    if (!id) {
      continue;
    }
    const uniqueName =
      typeof raw.uniqueName === 'string' && raw.uniqueName
        ? raw.uniqueName
        : null;
    const matchesId = me.id != null && id === me.id;
    const matchesName =
      me.uniqueName != null &&
      uniqueName != null &&
      uniqueName.toLowerCase() === me.uniqueName.toLowerCase();
    if (matchesId || matchesName) {
      return {
        id,
        uniqueName,
        vote: typeof raw.vote === 'number' ? raw.vote : 0,
      };
    }
  }
  return null;
}

/**
 * Resolves the identity id the reviewer-vote endpoint accepts. The profile id
 * from `fetchAzureUser` is an account id that this endpoint rejects, so we
 * prefer the id from the PR's own reviewers list, then `connectionData`'s
 * org-scoped `authenticatedUser.id`, and only fall back to the profile id.
 */
async function resolveReviewerId(
  deps: AzureApprovalDeps,
  target: AzurePrTarget,
  token: string,
  me: AzureUserIdentity | null,
  mine: AzureReviewerVote | null,
): Promise<string> {
  if (mine) {
    return mine.id;
  }
  const conn = await deps.httpGet(connectionDataUrl(target.org), token);
  if (conn.status === 200) {
    const id = parseAuthenticatedUser(conn.body).id;
    if (id) {
      return id;
    }
  }
  if (me?.id) {
    return me.id;
  }
  throw new ProviderError(
    'Could not resolve the Azure DevOps reviewer identity for the signed-in user.',
  );
}

/** Builds a gateway that approves an Azure DevOps PR as the signed-in reviewer. */
export function createAzureApprovalGateway(
  deps: AzureApprovalDeps,
  target: AzurePrTarget,
): PrApprovalGateway {
  const authorize = async (): Promise<string> => {
    const token = await deps.token(target.org);
    if (!token) {
      throw new ProviderError(
        'Not signed in to Azure DevOps. Sign in first, then try again.',
      );
    }
    return token;
  };

  return {
    async approve(): Promise<PrApprovalResult> {
      const token = await authorize();
      const me = await fetchAzureUser(deps, target.org);

      // Read the PR's reviewers to find our existing vote (already approved?)
      // and, crucially, the reviewer id in the identity namespace the vote
      // endpoint accepts.
      const detail = await deps.httpGet(pullDetailUrl(target), token);
      const mine =
        detail.status === 200 ? findMyReviewer(detail.body, me) : null;
      const reviewer = mine?.uniqueName ?? me?.uniqueName ?? undefined;

      if (mine?.vote === APPROVED_VOTE) {
        return {
          approved: true,
          state: 'approved',
          alreadyApproved: true,
          ...(reviewer ? { reviewer } : {}),
        };
      }

      const id = await resolveReviewerId(deps, target, token, me, mine);
      const res = await deps.httpPut(
        reviewerVoteUrl(target, id),
        token,
        approvalVoteBody(),
      );
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(
          `Failed to approve Azure DevOps pull request (HTTP ${res.status})`,
        );
      }
      return {
        approved: true,
        state: 'approved',
        alreadyApproved: false,
        ...(reviewer ? { reviewer } : {}),
      };
    },
  };
}
