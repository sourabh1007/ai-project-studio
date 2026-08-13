import { describe, expect, it } from 'vitest';
import type { Repository } from '../repo/repo-contract.js';
import type {
  PrApprovalGateway,
  PrApprovalGatewayResolver,
} from './pr-approval-contract.js';
import type { PrReview, PrReviewPull } from './pr-review-contract.js';
import { createPrApprovalService } from './pr-approval-service.js';

function repo(id: string): Repository {
  return {
    id,
    provider: 'github',
    remoteUrl: 'https://github.com/acme/widgets.git',
    name: 'acme/widgets',
    localPath: `C:\\repos\\${id}`,
    defaultBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function review(featureId: string, repoId: string): PrReview {
  return {
    featureId,
    repoId,
    pull: {
      number: 7,
      title: 'Add widget',
      url: 'https://github.com/acme/widgets/pull/7',
    },
  } as unknown as PrReview;
}

function gateway(): PrApprovalGateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    approve: async () => {
      calls.push('approve');
      return { approved: true, state: 'approved', reviewer: 'alice' };
    },
  };
}

function resolver(
  gw: PrApprovalGateway,
  onResolve?: (repo: Repository, pull: PrReviewPull) => void,
): PrApprovalGatewayResolver {
  return {
    resolve: (r, p) => {
      onResolve?.(r, p);
      return gw;
    },
  };
}

function setup(options: {
  reviews?: Map<string, PrReview>;
  repos?: Map<string, Repository>;
  onResolve?: (repo: Repository, pull: PrReviewPull) => void;
} = {}) {
  const gw = gateway();
  const service = createPrApprovalService({
    reviews: { get: (id) => options.reviews?.get(id) ?? null },
    repos: { get: (id) => options.repos?.get(id) ?? null },
    gateways: resolver(gw, options.onResolve),
  });
  return { service, gateway: gw };
}

describe('createPrApprovalService', () => {
  it('approves via the resolved gateway', async () => {
    const { service, gateway: gw } = setup({
      reviews: new Map([['f1', review('f1', 'r1')]]),
      repos: new Map([['r1', repo('r1')]]),
    });
    await expect(service.approve('f1')).resolves.toEqual({
      approved: true,
      state: 'approved',
      reviewer: 'alice',
    });
    expect(gw.calls).toEqual(['approve']);
  });

  it('passes the repo and pull to the resolver', async () => {
    const seen: { value: { repo: Repository; pull: PrReviewPull } | null } = {
      value: null,
    };
    const { service } = setup({
      reviews: new Map([['f1', review('f1', 'r1')]]),
      repos: new Map([['r1', repo('r1')]]),
      onResolve: (r, p) => {
        seen.value = { repo: r, pull: p };
      },
    });
    await service.approve('f1');
    expect(seen.value?.repo.id).toBe('r1');
    expect(seen.value?.pull.number).toBe(7);
  });

  it('throws when the feature has no PR review', async () => {
    const { service } = setup();
    await expect(service.approve('missing')).rejects.toThrow(
      /No PR review for feature missing/,
    );
  });

  it('throws when the review references an unknown repository', async () => {
    const { service } = setup({
      reviews: new Map([['f1', review('f1', 'gone')]]),
    });
    await expect(service.approve('f1')).rejects.toThrow(/No repository gone/);
  });
});
