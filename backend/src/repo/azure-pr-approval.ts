import { ProviderError } from '../kernel/error-types.js';
import type {
  AzureHttpGetter,
  AzureHttpPutter,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import type { AzureUserIdentity } from './azure-pr-lister.js';
import { fetchAzureUser } from './azure-pr-lister.js';
import type {
  PrApprovalGateway,
  PrApprovalResult,
} from '../pr-review/pr-approval-contract.js';
import type { AzurePrTarget } from './azure-pr-comments.js';

const API_VERSION = '7.1';

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

/** The request body Azure DevOps uses for an approval vote. */
export function approvalVoteBody(): unknown {
  return { vote: 10 };
}

function reviewerId(user: AzureUserIdentity | null): string {
  if (user?.id) {
    return user.id;
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
      const id = reviewerId(me);
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
        ...(me?.uniqueName ? { reviewer: me.uniqueName } : {}),
      };
    },
  };
}
