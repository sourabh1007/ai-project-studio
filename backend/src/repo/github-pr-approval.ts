import type { GhRunner } from '../github-auth/github-auth-service.js';
import { ProviderError, ValidationError } from '../kernel/error-types.js';
import type {
  PrApprovalGateway,
  PrApprovalResult,
} from '../pr-review/pr-approval-contract.js';
import type { GithubPrTarget } from './github-pr-comments.js';

/** Builds the `gh api` argv that approves the pull request via GitHub REST. */
export function approvePrArgs(target: GithubPrTarget, expectedHeadSha?: string): string[] {
  return [
    'api',
    '--method',
    'POST',
    `/repos/${target.repo}/pulls/${target.number}/reviews`,
    '-f',
    'event=APPROVE',
    ...(expectedHeadSha ? ['-f', `commit_id=${expectedHeadSha}`] : []),
  ];
}

/** Maps GitHub's review response onto the small UI-facing approval result. */
export function parseGithubApproval(stdout: string): PrApprovalResult {
  let reviewer: string | undefined;
  try {
    const parsed = JSON.parse(stdout) as {
      state?: unknown;
      user?: { login?: unknown } | null;
    };
    if (parsed?.state !== 'APPROVED') throw new Error('Approval not confirmed');
    if (typeof parsed.user?.login === 'string' && parsed.user.login) {
      reviewer = parsed.user.login;
    }
  } catch {
    throw new ProviderError('GitHub did not confirm an approved review.');
  }
  return { approved: true, state: 'approved', ...(reviewer ? { reviewer } : {}) };
}

/** Builds a gateway that approves a GitHub PR through the authenticated `gh` CLI. */
export function createGithubApprovalGateway(
  run: GhRunner,
  target: GithubPrTarget,
): PrApprovalGateway {
  async function read(args: string[]): Promise<unknown> {
    const result = await run(args);
    if (result.code !== 0) throw new ProviderError(result.stderr.trim() || 'Could not verify GitHub approval status.');
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new ProviderError('GitHub returned invalid approval status.');
    }
  }
  async function getHeadSha(): Promise<string> {
    const detail = await read(['api', `/repos/${target.repo}/pulls/${target.number}`]) as { head?: { sha?: unknown }; state?: unknown };
    if (detail?.state !== 'open' || typeof detail.head?.sha !== 'string' || !detail.head.sha) {
      throw new ProviderError('Cannot approve: GitHub pull request is closed or its head could not be verified.');
    }
    return detail.head.sha;
  }
  return {
    getHeadSha,
    async approve(expectedHeadSha) {
      if (expectedHeadSha) {
        if (await getHeadSha() !== expectedHeadSha) throw new ValidationError('Pull request head changed before approval. Reset and review the latest commit.');
        const user = await read(['api', '/user']) as { login?: unknown };
        if (typeof user?.login !== 'string' || !user.login) throw new ProviderError('Could not verify the GitHub reviewer identity.');
        const pages = await read(['api', '--paginate', '--slurp',
          `/repos/${target.repo}/pulls/${target.number}/reviews?per_page=100`]);
        if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new ProviderError('Could not verify existing GitHub reviews.');
        const mine = pages.flat().filter((review) => review?.user?.login === user.login &&
          ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)).at(-1);
        if (mine?.state === 'APPROVED' && mine.commit_id === expectedHeadSha) {
          return { approved: true, state: 'approved', reviewer: user.login, alreadyApproved: true };
        }
      }
      const res = await run(approvePrArgs(target, expectedHeadSha));
      if (res.code !== 0) {
        throw new ProviderError(
          res.stderr.trim() || `Failed to approve GitHub PR #${target.number}`,
        );
      }
      return parseGithubApproval(res.stdout);
    },
  };
}
