import type { GhRunner } from '../github-auth/github-auth-service.js';
import { ProviderError } from '../kernel/error-types.js';
import type {
  PrApprovalGateway,
  PrApprovalResult,
} from '../pr-review/pr-approval-contract.js';
import type { GithubPrTarget } from './github-pr-comments.js';

/** Builds the `gh api` argv that approves the pull request via GitHub REST. */
export function approvePrArgs(target: GithubPrTarget): string[] {
  return [
    'api',
    '--method',
    'POST',
    `/repos/${target.repo}/pulls/${target.number}/reviews`,
    '-f',
    'event=APPROVE',
  ];
}

/** Maps GitHub's review response onto the small UI-facing approval result. */
export function parseGithubApproval(stdout: string): PrApprovalResult {
  let reviewer: string | undefined;
  try {
    const parsed = JSON.parse(stdout) as {
      user?: { login?: unknown } | null;
    };
    if (typeof parsed.user?.login === 'string' && parsed.user.login) {
      reviewer = parsed.user.login;
    }
  } catch {
    reviewer = undefined;
  }
  return { approved: true, state: 'approved', ...(reviewer ? { reviewer } : {}) };
}

/** Builds a gateway that approves a GitHub PR through the authenticated `gh` CLI. */
export function createGithubApprovalGateway(
  run: GhRunner,
  target: GithubPrTarget,
): PrApprovalGateway {
  return {
    async approve() {
      const res = await run(approvePrArgs(target));
      if (res.code !== 0) {
        throw new ProviderError(
          res.stderr.trim() || `Failed to approve GitHub PR #${target.number}`,
        );
      }
      return parseGithubApproval(res.stdout);
    },
  };
}
