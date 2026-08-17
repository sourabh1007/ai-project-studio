import type { GhRunner } from '../github-auth/github-auth-service.js';
import { ProviderError } from '../kernel/error-types.js';
import type { PrDescriptionGateway } from '../pr-review/pr-description-contract.js';
import type { GithubPrTarget } from './github-pr-comments.js';

/** `gh` argv that reads the pull request's body as raw text. */
export function readBodyArgs(target: GithubPrTarget): string[] {
  return [
    'pr',
    'view',
    String(target.number),
    '--repo',
    target.repo,
    '--json',
    'body',
    '--jq',
    '.body',
  ];
}

/** `gh` argv that overwrites the pull request's body. */
export function writeBodyArgs(target: GithubPrTarget, body: string): string[] {
  return [
    'pr',
    'edit',
    String(target.number),
    '--repo',
    target.repo,
    '--body',
    body,
  ];
}

/** Builds a gateway that reads/updates a GitHub PR body through `gh`. */
export function createGithubDescriptionGateway(
  run: GhRunner,
  target: GithubPrTarget,
): PrDescriptionGateway {
  return {
    async getBody() {
      const res = await run(readBodyArgs(target));
      if (res.code !== 0) {
        throw new ProviderError(
          res.stderr.trim() || `Failed to read GitHub PR #${target.number}`,
        );
      }
      return res.stdout.replace(/\r?\n$/, '');
    },
    async setBody(body) {
      const res = await run(writeBodyArgs(target, body));
      if (res.code !== 0) {
        throw new ProviderError(
          res.stderr.trim() ||
            `Failed to update GitHub PR #${target.number} description`,
        );
      }
    },
  };
}
