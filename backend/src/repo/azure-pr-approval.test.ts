import { describe, expect, it } from 'vitest';
import type { AzureHttpGetter, AzureHttpResponse } from './azure-repo-lister.js';
import {
  approvalVoteBody,
  createAzureApprovalGateway,
  findMyReviewer,
  pullDetailUrl,
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

const PROFILE = { id: 'profile-1', emailAddress: 'alice@example.com' };

/** Routes GETs by endpoint so each test can shape the identity / PR lookups. */
function router(routes: {
  profile?: AzureHttpResponse;
  connection?: AzureHttpResponse;
  detail?: AzureHttpResponse;
}): AzureHttpGetter {
  return async (url) => {
    if (url.includes('/profile/profiles/me')) {
      return routes.profile ?? resp(200, PROFILE);
    }
    if (url.includes('/_apis/connectionData')) {
      return routes.connection ?? resp(404);
    }
    return routes.detail ?? resp(200, {});
  };
}

function deps(overrides: Partial<AzureApprovalDeps> = {}): AzureApprovalDeps {
  return {
    token: async () => 'tok',
    httpGet: router({}),
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

  it('builds the pull detail url', () => {
    expect(pullDetailUrl(TARGET)).toBe(
      'https://dev.azure.com/acme/Widgets/_apis/git/repositories/core' +
        '/pullRequests/42?api-version=7.1',
    );
  });

  it('builds the approval vote body', () => {
    expect(approvalVoteBody()).toEqual({ vote: 10 });
  });
});

describe('findMyReviewer', () => {
  const me = { id: 'id-1', uniqueName: 'alice@example.com' };

  it('returns null when there is no reviewers array', () => {
    expect(findMyReviewer({}, me)).toBeNull();
  });

  it('returns null when the identity is unknown', () => {
    expect(findMyReviewer({ reviewers: [{ id: 'x' }] }, null)).toBeNull();
  });

  it('skips reviewers without an id and matches by unique name', () => {
    const body = {
      reviewers: [
        { uniqueName: 'alice@example.com' },
        { id: 'ns-9', uniqueName: 'ALICE@example.com', vote: 5 },
      ],
    };
    expect(findMyReviewer(body, me)).toEqual({
      id: 'ns-9',
      uniqueName: 'ALICE@example.com',
      vote: 5,
    });
  });

  it('matches by id and defaults a missing vote to zero', () => {
    const body = { reviewers: [{ id: 'id-1' }] };
    expect(findMyReviewer(body, me)).toEqual({
      id: 'id-1',
      uniqueName: null,
      vote: 0,
    });
  });

  it('returns null when no reviewer matches', () => {
    const body = { reviewers: [{ id: 'other', uniqueName: 'bob@example.com' }] };
    expect(findMyReviewer(body, me)).toBeNull();
  });
});

describe('createAzureApprovalGateway', () => {
  it('approves using the reviewer-list id and reports the reviewer', async () => {
    let sent: { url: string; token: string; body: unknown } | null = null;
    const gw = createAzureApprovalGateway(
      deps({
        httpGet: router({
          detail: resp(200, {
            reviewers: [
              { id: 'ns-id', uniqueName: 'alice@example.com', vote: 0 },
            ],
          }),
        }),
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
      alreadyApproved: false,
      reviewer: 'alice@example.com',
    });
    expect(sent).toEqual({
      url: reviewerVoteUrl(TARGET, 'ns-id'),
      token: 'tok',
      body: { vote: 10 },
    });
  });

  it('short-circuits when the reviewer already approved', async () => {
    let putCalls = 0;
    const gw = createAzureApprovalGateway(
      deps({
        httpGet: router({
          detail: resp(200, {
            reviewers: [
              { id: 'ns-id', uniqueName: 'alice@example.com', vote: 10 },
            ],
          }),
        }),
        httpPut: async () => {
          putCalls += 1;
          return resp(200, {});
        },
      }),
      TARGET,
    );
    await expect(gw.approve()).resolves.toEqual({
      approved: true,
      state: 'approved',
      alreadyApproved: true,
      reviewer: 'alice@example.com',
    });
    expect(putCalls).toBe(0);
  });

  it('reports already approved without a reviewer when no email is known', async () => {
    const gw = createAzureApprovalGateway(
      deps({
        httpGet: router({
          profile: resp(200, { id: 'profile-1' }),
          detail: resp(200, { reviewers: [{ id: 'profile-1', vote: 10 }] }),
        }),
      }),
      TARGET,
    );
    await expect(gw.approve()).resolves.toEqual({
      approved: true,
      state: 'approved',
      alreadyApproved: true,
    });
  });

  it('falls back to the connectionData identity when not yet a reviewer', async () => {
    let sent: string | null = null;
    const gw = createAzureApprovalGateway(
      deps({
        httpGet: router({
          detail: resp(200, { reviewers: [] }),
          connection: resp(200, { authenticatedUser: { id: 'conn-id' } }),
        }),
        httpPut: async (url) => {
          sent = url;
          return resp(200, {});
        },
      }),
      TARGET,
    );
    await expect(gw.approve()).resolves.toEqual({
      approved: true,
      state: 'approved',
      alreadyApproved: false,
      reviewer: 'alice@example.com',
    });
    expect(sent).toBe(reviewerVoteUrl(TARGET, 'conn-id'));
  });

  it('falls back to the profile id when connectionData has no identity', async () => {
    let sent: string | null = null;
    const gw = createAzureApprovalGateway(
      deps({
        httpGet: router({
          detail: resp(500),
          connection: resp(200, {}),
        }),
        httpPut: async (url) => {
          sent = url;
          return resp(200, {});
        },
      }),
      TARGET,
    );
    await gw.approve();
    expect(sent).toBe(reviewerVoteUrl(TARGET, 'profile-1'));
  });

  it('throws when not signed in', async () => {
    const gw = createAzureApprovalGateway(
      deps({ token: async () => null }),
      TARGET,
    );
    await expect(gw.approve()).rejects.toThrow(/Not signed in/);
  });

  it('throws when no reviewer identity can be resolved', async () => {
    const gw = createAzureApprovalGateway(
      deps({
        httpGet: router({
          profile: resp(200, { emailAddress: 'alice@example.com' }),
          connection: resp(404),
          detail: resp(200, { reviewers: [] }),
        }),
      }),
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

  it('omits the reviewer when no email is available', async () => {
    const gw = createAzureApprovalGateway(
      deps({
        httpGet: router({
          profile: resp(200, { id: 'profile-1' }),
          detail: resp(200, { reviewers: [] }),
          connection: resp(200, { authenticatedUser: { id: 'conn-id' } }),
        }),
      }),
      TARGET,
    );
    await expect(gw.approve()).resolves.toEqual({
      approved: true,
      state: 'approved',
      alreadyApproved: false,
    });
  });
});
