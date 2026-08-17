import { ProviderError } from '../kernel/error-types.js';
import type {
  AzureHttpGetter,
  AzureHttpPatcher,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import type { AzurePrTarget } from './azure-pr-comments.js';
import type { PrDescriptionGateway } from '../pr-review/pr-description-contract.js';

const API_VERSION = '7.1';

/** The deps an Azure description gateway needs: auth, a GET and a PATCH. */
export interface AzureDescriptionDeps {
  token: AzureTokenGetter;
  httpGet: AzureHttpGetter;
  httpPatch: AzureHttpPatcher;
}

/** REST URL for a single pull request (read + patch its description). */
export function pullUrl(target: AzurePrTarget): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/git/repositories` +
    `/${encodeURIComponent(target.repo)}/pullRequests` +
    `/${target.pullRequestId}?api-version=${API_VERSION}`
  );
}

/** Reads the `description` string off an Azure pull-request payload. */
export function parseDescription(body: unknown): string {
  const description = (body as { description?: unknown })?.description;
  return typeof description === 'string' ? description : '';
}

/** Builds a gateway that reads/updates an Azure DevOps PR description via REST. */
export function createAzureDescriptionGateway(
  deps: AzureDescriptionDeps,
  target: AzurePrTarget,
): PrDescriptionGateway {
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
    async getBody() {
      const token = await authorize();
      const res = await deps.httpGet(pullUrl(target), token);
      if (res.status !== 200) {
        throw new ProviderError(
          `Failed to read Azure DevOps pull request (HTTP ${res.status})`,
        );
      }
      return parseDescription(res.body);
    },
    async setBody(body) {
      const token = await authorize();
      const res = await deps.httpPatch(pullUrl(target), token, {
        description: body,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(
          `Failed to update Azure DevOps pull request description (HTTP ${res.status})`,
        );
      }
    },
  };
}
