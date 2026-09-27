import { describe, expect, it, vi } from 'vitest';
import { REVIEW_PERSPECTIVE_IDS } from '../review-board/review-board-perspective-prompts.js';
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
    headSha: 'reviewed-head',
    description: null, changedFiles: 1,
    changeGraph: { status: 'ready', generatedAt: 'graph-revision', projects: [], nodes: [] },
    reviewBoardAnalysis: {
      headSha: 'reviewed-head', graphGeneratedAt: 'graph-revision',
      analyses: Object.fromEntries(REVIEW_PERSPECTIVE_IDS.map((id) => [id, { perspectiveId: id }])),
    },
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
    getHeadSha: async () => 'reviewed-head',
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
  it('pins the confirmation to its evidence revision when supplied', async () => {
    const { service, gateway } = ready();
    await expect(service.approve('f1', 'reviewed-head', 'old-revision')).rejects.toThrow('since confirmation');
    expect(gateway.calls).toEqual([]);
    await expect(service.approve('f1', 'reviewed-head', 'graph-revision')).resolves.toMatchObject({ approved: true });
  });

  it('blocks a same-head evidence replacement during live preflight', async () => {
    const { service, reviews, gateway } = ready();
    gateway.getHeadSha = async () => {
      const current = reviews.get('f1')!;
      current.changeGraph.generatedAt = 'replacement';
      current.reviewBoardAnalysis!.graphGeneratedAt = 'replacement';
      return 'reviewed-head';
    };
    await expect(service.approve('f1', 'reviewed-head')).rejects.toThrow('Review changed');
    expect(gateway.calls).toEqual([]);
  });
  function ready() {
    const reviews = new Map([['f1', review('f1', 'r1')]]);
    const repos = new Map([['r1', repo('r1')]]);
    return { reviews, ...setup({ reviews, repos }) };
  }

  it('exposes a read-only lightweight approval status', async () => {
    const { service, gateway } = ready();
    await expect(service.status!('f1')).resolves.toEqual({
      reviewedHeadSha: 'reviewed-head', currentHeadSha: 'reviewed-head', canApprove: true, reason: null,
    });
    gateway.getHeadSha = async () => 'new-head';
    expect((await service.status!('f1')).canApprove).toBe(false);
    expect(gateway.calls).toEqual([]);
  });
  it('supports an unknown changed-file count without weakening completion checks', async () => {
    const { service, reviews } = ready();
    reviews.get('f1')!.changedFiles = null;
    expect((await service.status!('f1')).canApprove).toBe(true);
  });

  it('requires the exact expected reviewed head', async () => {
    const { service, gateway } = ready();
    await expect(service.approve('f1')).rejects.toThrow('expected reviewed head');
    await expect(service.approve('f1', 'stale')).rejects.toThrow('expected reviewed head');
    expect(gateway.calls).toEqual([]);
  });

  it.each(['missing-head', 'failed', 'no-snapshot', 'stale-head', 'stale-graph', 'incomplete'])(
    'blocks approval with %s evidence', async (variant) => {
      const { reviews, service, gateway } = ready();
      const value = reviews.get('f1')!;
      if (variant === 'missing-head') value.headSha = null;
      if (variant === 'failed') value.changeGraph.status = 'failed';
      if (variant === 'no-snapshot') delete value.reviewBoardAnalysis;
      if (variant === 'stale-head') value.reviewBoardAnalysis!.headSha = 'old';
      if (variant === 'stale-graph') value.reviewBoardAnalysis!.graphGeneratedAt = 'old';
      if (variant === 'incomplete') delete value.reviewBoardAnalysis!.analyses.security;
      expect((await service.status!('f1')).canApprove).toBe(false);
      await expect(service.approve('f1', 'reviewed-head')).rejects.toThrow();
      expect(gateway.calls).toEqual([]);
    },
  );

  it('blocks a head change or evidence reset during live preflight', async () => {
    const { reviews, service, gateway } = ready();
    gateway.getHeadSha = async () => 'new-head';
    await expect(service.approve('f1', 'reviewed-head')).rejects.toThrow('head changed');
    gateway.getHeadSha = async () => {
      const value = reviews.get('f1')!;
      value.headSha = 'next-head';
      value.reviewBoardAnalysis!.headSha = 'next-head';
      return 'next-head';
    };
    await expect(service.approve('f1', 'reviewed-head')).rejects.toThrow('Review changed');
    expect(gateway.calls).toEqual([]);
  });

  it('coalesces duplicate approval clicks and does not cache provider failure', async () => {
    const { service, gateway } = ready();
    let resolve!: (head: string) => void;
    gateway.getHeadSha = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    gateway.approve = vi.fn(async () => { throw new Error('provider denied'); });
    const first = service.approve('f1', 'reviewed-head');
    const second = service.approve('f1', 'reviewed-head');
    resolve('reviewed-head');
    await expect(first).rejects.toThrow('provider denied');
    await expect(second).rejects.toThrow('provider denied');
    expect(gateway.getHeadSha).toHaveBeenCalledTimes(1);
    expect(gateway.approve).toHaveBeenCalledTimes(1);
    gateway.getHeadSha = async () => 'reviewed-head';
    await expect(service.approve('f1', 'reviewed-head')).rejects.toThrow('provider denied');
    expect(gateway.approve).toHaveBeenCalledTimes(2);
  });
  it('approves via the resolved gateway', async () => {
    const { service, gateway: gw } = setup({
      reviews: new Map([['f1', review('f1', 'r1')]]),
      repos: new Map([['r1', repo('r1')]]),
    });
    await expect(service.approve('f1', 'reviewed-head')).resolves.toEqual({
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
    await service.approve('f1', 'reviewed-head');
    expect(seen.value?.repo.id).toBe('r1');
    expect(seen.value?.pull.number).toBe(7);
  });

  it('throws when the feature has no PR review', async () => {
    const { service } = setup();
    await expect(service.approve('missing')).rejects.toThrow(
      /No code review for feature missing/,
    );
  });

  it('throws when the review references an unknown repository', async () => {
    const { service } = setup({
      reviews: new Map([['f1', review('f1', 'gone')]]),
    });
    await expect(service.approve('f1')).rejects.toThrow(/No repository gone/);
  });
});
