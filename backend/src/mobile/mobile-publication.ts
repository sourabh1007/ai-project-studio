import { ConflictError, ProviderError, ValidationError } from '../kernel/error-types.js';
import type { NewTaskRun } from '../new-task/new-task-contract.js';
import { parseNameStatus } from '../new-task/new-task-git.js';
import type { MobileApproval, MobileChatRecord } from './mobile-contract.js';
import { z } from 'zod';

const pullList = z.array(z.object({
  number: z.number().int().positive(), url: z.string().url(), headRefOid: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
}));

export interface MobilePublicationDeps {
  git(args: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }>;
  gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  resolve(chat: MobileChatRecord): { worktreePath: string; baseBranch: string; branch: string; repoName: string; remoteUrl: string };
  getRun(id: string): NewTaskRun;
  saveRun(run: NewTaskRun): void;
  now(): string;
  makeEligible(chat: MobileChatRecord, number: number): Promise<string>;
}

export function createMobilePublication(deps: MobilePublicationDeps) {
  const git = async (path: string, args: string[], signal?: AbortSignal): Promise<string> => {
    const result = await deps.git(['-C', path, ...args], signal);
    if (result.code !== 0) throw new ProviderError(result.stderr.trim() || 'Mobile Git operation failed.');
    return result.stdout.trim();
  };
  const gh = async (args: string[]): Promise<string> => {
    const result = await deps.gh(args);
    if (result.code !== 0) throw new ProviderError(result.stderr.trim() || 'GitHub publication failed.');
    return result.stdout.trim();
  };
  const revision = async (chat: MobileChatRecord, signal?: AbortSignal) => {
    const scope = deps.resolve(chat);
    const repo = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(scope.repoName);
    if (!repo || ![
      `https://github.com/${scope.repoName}`, `https://github.com/${scope.repoName}.git`,
      `git@github.com:${scope.repoName}.git`,
    ].includes(scope.remoteUrl)) {
      throw new ValidationError('Mobile publication requires a canonical github.com repository URL without embedded credentials.');
    }
    if (await git(scope.worktreePath, ['status', '--porcelain', '--untracked-files=all'], signal)) {
      throw new ConflictError('The worktree has uncommitted changes. Finish or discard them explicitly before reviewing publication.');
    }
    const branch = await git(scope.worktreePath, ['symbolic-ref', '--short', 'HEAD'], signal);
    if (branch !== scope.branch) throw new ConflictError('The checked-out branch changed. Restore the task branch before publication.');
    const head = await git(scope.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'], signal);
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new ValidationError('Git did not return a valid commit revision.');
    const remote = await git(scope.worktreePath, ['remote', 'get-url', '--push', 'origin'], signal);
    if (remote !== scope.remoteUrl) throw new ConflictError('The push destination differs from the registered repository. Review the host repository configuration.');
    const files = parseNameStatus(await git(scope.worktreePath, ['diff', '--name-status', `${scope.baseBranch}...${head}`], signal));
    return { head, branch, baseBranch: scope.baseBranch, remoteUrl: remote, files };
  };
  return {
    revision,
    async publish(chat: MobileChatRecord, approval: MobileApproval, signal: AbortSignal): Promise<NewTaskRun> {
      const scope = deps.resolve(chat);
      const current = await revision(chat, signal);
      if (current.head !== approval.head || current.branch !== approval.branch ||
          current.baseBranch !== approval.baseBranch || current.remoteUrl !== approval.remoteUrl ||
          chat.repoId !== approval.repoId) {
        throw new ConflictError('The reviewed revision is stale. Review a new publication preview.');
      }
      signal.throwIfAborted();
      // Pin both the source and destination; a later local HEAD move cannot
      // turn this approval into permission to push a different commit.
      await git(scope.worktreePath, ['push', '--', scope.remoteUrl, `${approval.head}:refs/heads/${approval.branch}`], signal);
      signal.throwIfAborted();
      const remoteHead = await git(scope.worktreePath, ['ls-remote', '--', scope.remoteUrl, `refs/heads/${approval.branch}`], signal);
      if (remoteHead.split(/\s+/)[0] !== approval.head) {
        throw new ConflictError('The remote branch changed during publication. Inspect GitHub before reviewing a new preview.');
      }
      const raw = await gh(['pr', 'list', '--repo', scope.repoName, '--head', approval.branch,
        '--base', approval.baseBranch, '--state', 'all', '--json', 'number,url,headRefOid,state', '--limit', '20']);
      const pulls = pullList.safeParse(JSON.parse(raw));
      if (!pulls.success) throw new ProviderError('GitHub returned an invalid pull-request list.');
      const existing = pulls.data.find((pull) => pull.state === 'OPEN');
      let number: number;
      let url: string;
      if (existing) {
        if (existing.headRefOid !== approval.head) {
          throw new ConflictError('An open pull request contains a different revision. Inspect GitHub before retrying.');
        }
        number = existing.number;
        url = existing.url;
      } else {
        signal.throwIfAborted();
        url = await gh(['pr', 'create', '--draft', '--repo', scope.repoName, '--head', approval.branch,
          '--base', approval.baseBranch, '--title', approval.title, '--body', approval.body]);
        const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(url);
        if (!match) throw new ProviderError('GitHub did not return a valid draft pull-request URL. Inspect GitHub before retrying.');
        number = Number(match[1]);
      }
      if (url !== `https://github.com/${scope.repoName}/pull/${number}`) {
        throw new ProviderError('GitHub returned a pull request for a different repository.');
      }
      const pullHead = await gh(['pr', 'view', String(number), '--repo', scope.repoName, '--json', 'headRefOid', '--jq', '.headRefOid']);
      if (pullHead !== approval.head) throw new ConflictError('The pull request exists but its head changed. Inspect GitHub; do not retry blindly.');
      signal.throwIfAborted();
      const reviewFeatureId = await deps.makeEligible(chat, number);
      const run: NewTaskRun = {
        ...deps.getRun(chat.attachmentId), status: 'pr-created', prNumber: number, prUrl: url,
        reviewFeatureId, error: null, updatedAt: deps.now(),
      };
      deps.saveRun(run);
      return run;
    },
  };
}
