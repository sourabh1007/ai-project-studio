import { describe, expect, it } from 'vitest';
import type { AzureHttpResponse } from './azure-repo-lister.js';
import {
  approvalVoteBody,
  createAzureApprovalGateway,
  reviewerVoteUrl,
  type AzureApprovalDeps,
} from './azure-pr-approval.js';
import type { AzurePrTarget } from './azure-pr-comments.js';

const TARGET: AzurePrTarget = {
  org: 'acme',
  project: 'Widgets',
  repo: 'core',
  pullRequestId: 42,
};

function resp(status: number, body: unknown = null): AzureHttpResponse {
  return { status, body };
}

function deps(overrides: Partial<AzureApprovalDeps> = {}): AzureApprovalDeps {
  return {
    token: async () => 'tok',
    httpGet: async () =>
      resp(200, { id: 'user-1', emailAddress: 'alice@example.com' }),
    httpPut: async () => resp(200, {}),
    ...overrides,
  };
}

describe('approval helpers', () => {
  it('builds the reviewer vote url', () => {
    expect(reviewerVoteUrl(TARGET, 'user 1')).toBe(
      'https://dev.azure.com/acme/Widgets/_apis/git/repositories/core' +
        '/pullRequests/42/reviewers/user%201?api-version=7.1',
    );
  });

  it('builds the approval vote body', () => {
    expect(approvalVoteBody()).toEqual({ vote: 10 });
  });
});

describe('createAzureApprovalGateway', () => {
  it('casts an approval vote for the signed-in reviewer', async () => {
    let sent: { url: string; token: string; body: unknown } | null = null;
    const gw = createAzureApprovalGateway(
      deps({
        httpPut: async (url, token, body) => {
          sent = { url, token, body };
          return resp(200, {});
        },
      }),
      TARGET,
    );
    await expect(gw.approve()).resolves.toEqual({
      approved: true,
      state: 'approved',
      reviewer: 'alice@example.com',
    });
    expect(sent).toEqual({
      url: reviewerVoteUrl(TARGET, 'user-1'),
      token: 'tok',
      body: { vote: 10 },
    });
  });

  it('throws when not signed in', async () => {
    const gw = createAzureApprovalGateway(deps({ token: async () => null }), TARGET);
    await expect(gw.approve()).rejects.toThrow(/Not signed in/);
  });

  it('throws when the reviewer identity has no id', async () => {
    const gw = createAzureApprovalGateway(
      deps({ httpGet: async () => resp(200, { emailAddress: 'alice@example.com' }) }),
      TARGET,
    );
    await expect(gw.approve()).rejects.toThrow(/reviewer identity/);
  });

  it('throws when Azure returns an error status', async () => {
    const gw = createAzureApprovalGateway(
      deps({ httpPut: async () => resp(403) }),
      TARGET,
    );
    await expect(gw.approve()).rejects.toThrow(/HTTP 403/);
  });

  it('returns no reviewer when the profile has no email', async () => {
    const gw = createAzureApprovalGateway(
      deps({ httpGet: async () => resp(200, { id: 'user-1' }) }),
      TARGET,
    );
    await expect(gw.approve()).resolves.toEqual({
      approved: true,
      state: 'approved',
    });
  });
});
