import { describe, expect, it, vi } from 'vitest';
import { createPrDescriptionService } from './pr-description-service.js';
import type { PrDescriptionGateway } from './pr-description-contract.js';
import type { PrReview } from './pr-review-contract.js';
import type { Repository } from '../repo/repo-contract.js';

function review(): PrReview {
  return {
    featureId: 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'PR', url: 'https://example/pr/7' },
    worktreePath: '/wt',
    baseBranch: 'main',
    description: null,
    problemStatement: {
      status: 'ready',
      metaSessionId: null,
      usage: null,
      failure: null,
      activity: [],
      generatedAt: null,
      content: 'Fixes it.',
      sufficient: true,
    },
    changeGraph: {
      status: 'ready',
      metaSessionId: null,
      usage: null,
      failure: null,
      activity: [],
      generatedAt: null,
      projects: [],
      nodes: [],
      edges: [],
    },
    changedFiles: null,
    timestamps: { createdAt: '', updatedAt: '' },
  };
}

const repo = { id: 'r1', provider: 'github' } as unknown as Repository;

function harness(overrides: {
  reviewValue?: PrReview | null;
  repoValue?: Repository | null;
  current?: string;
}) {
  const setBody = vi.fn(async (_body: string) => {});
  const gateway: PrDescriptionGateway = {
    getBody: async () => overrides.current ?? '',
    setBody,
  };
  const svc = createPrDescriptionService({
    reviews: { get: () => overrides.reviewValue ?? null },
    repos: { get: () => overrides.repoValue ?? null },
    gateways: { resolve: () => gateway },
  });
  return { svc, setBody };
}

describe('createPrDescriptionService', () => {
  it('writes the review block into the PR description and returns the url', async () => {
    const { svc, setBody } = harness({ reviewValue: review(), repoValue: repo });
    const result = await svc.exportToPull('f1');
    expect(result).toEqual({ updated: true, url: 'https://example/pr/7' });
    const written = setBody.mock.calls[0][0] as string;
    expect(written).toContain('Fixes it.');
    expect(written).toContain('ai-project-studio:pr-review:start');
  });

  it('throws when there is no review for the feature', async () => {
    const { svc } = harness({ reviewValue: null, repoValue: repo });
    await expect(svc.exportToPull('f1')).rejects.toThrow('No code review');
  });

  it('throws when the review targets an unknown repository', async () => {
    const { svc } = harness({ reviewValue: review(), repoValue: null });
    await expect(svc.exportToPull('f1')).rejects.toThrow('No repository');
  });
});
