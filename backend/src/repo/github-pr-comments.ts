import type { GhRunner } from '../github-auth/github-auth-service.js';
import { ProviderError } from '../kernel/error-types.js';
import type {
  AddPrCommentInput,
  PrComment,
  PrCommentThread,
  PrCommentThreadStatus,
  PrCommentsGateway,
} from '../pr-review/pr-comments-contract.js';

/** The `owner/name` slug plus PR number a GitHub gateway is bound to. */
export interface GithubPrTarget {
  /** Repository slug, `owner/name`. */
  repo: string;
  /** Pull-request number. */
  number: number;
}

interface GhThreadCommentNode {
  id?: string;
  body?: string;
  path?: string | null;
  line?: number | null;
  createdAt?: string | null;
  author?: { login?: string } | null;
}

interface GhThreadNode {
  id?: string;
  isResolved?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: { nodes?: GhThreadCommentNode[] | null } | null;
}

/**
 * The GraphQL query listing a PR's review threads with their comments. Kept as a
 * single-line string so it can be passed as `-f query=…` to `gh api graphql`.
 */
export const LIST_THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){' +
  'repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'id reviewThreads(first:100){nodes{id isResolved path line ' +
  'comments(first:100){nodes{id body path line createdAt author{login}}}}}}}}';

/** `mutation` resolving a review thread by node id. */
export const RESOLVE_THREAD_MUTATION =
  'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId})' +
  '{thread{id isResolved}}}';

/** `mutation` reopening a resolved review thread by node id. */
export const UNRESOLVE_THREAD_MUTATION =
  'mutation($threadId:ID!){unresolveReviewThread(input:{threadId:$threadId})' +
  '{thread{id isResolved}}}';

/** `mutation` creating a new inline review thread anchored to a file + line. */
export const ADD_THREAD_MUTATION =
  'mutation($pullRequestId:ID!,$path:String!,$line:Int!,$body:String!){' +
  'addPullRequestReviewThread(input:{pullRequestId:$pullRequestId,' +
  'path:$path,line:$line,side:RIGHT,body:$body}){thread{id isResolved path line ' +
  'comments(first:100){nodes{id body path line createdAt author{login}}}}}}';

/** Splits an `owner/name` slug into its GraphQL `owner` / `name` variables. */
export function splitSlug(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) {
    throw new ProviderError(`Not an owner/name GitHub slug: ${repo}`);
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/** Builds the `gh api graphql` argv listing a PR's review threads. */
export function listThreadsArgs(target: GithubPrTarget): string[] {
  const { owner, name } = splitSlug(target.repo);
  return [
    'api',
    'graphql',
    '-f',
    `query=${LIST_THREADS_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${target.number}`,
  ];
}

/** Builds the `gh api graphql` argv resolving / reopening a thread. */
export function setStatusArgs(
  threadId: string,
  status: PrCommentThreadStatus,
): string[] {
  const query =
    status === 'resolved' ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION;
  return ['api', 'graphql', '-f', `query=${query}`, '-F', `threadId=${threadId}`];
}

/** Builds the `gh api graphql` argv creating an inline comment thread. */
export function addThreadArgs(
  pullRequestId: string,
  input: AddPrCommentInput,
): string[] {
  return [
    'api',
    'graphql',
    '-f',
    `query=${ADD_THREAD_MUTATION}`,
    '-F',
    `pullRequestId=${pullRequestId}`,
    '-f',
    `path=${input.path}`,
    '-F',
    `line=${input.line}`,
    '-f',
    `body=${input.body}`,
  ];
}

/** Builds the `gh api graphql` argv fetching the PR's GraphQL node id. */
export function pullNodeIdArgs(target: GithubPrTarget): string[] {
  const { owner, name } = splitSlug(target.repo);
  return [
    'api',
    'graphql',
    '-f',
    'query=query($owner:String!,$name:String!,$number:Int!){' +
      'repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${target.number}`,
  ];
}

function mapComment(node: GhThreadCommentNode): PrComment | null {
  if (typeof node?.id !== 'string') {
    return null;
  }
  return {
    id: node.id,
    author: node.author?.login ?? null,
    body: typeof node.body === 'string' ? node.body : '',
    createdAt:
      typeof node.createdAt === 'string' && node.createdAt
        ? node.createdAt
        : null,
  };
}

function mapThread(node: GhThreadNode): PrCommentThread | null {
  if (typeof node?.id !== 'string') {
    return null;
  }
  const comments: PrComment[] = [];
  for (const c of node.comments?.nodes ?? []) {
    const mapped = mapComment(c);
    if (mapped) {
      comments.push(mapped);
    }
  }
  const first = node.comments?.nodes?.[0];
  return {
    id: node.id,
    path: node.path ?? first?.path ?? null,
    line: typeof node.line === 'number' ? node.line : first?.line ?? null,
    status: node.isResolved ? 'resolved' : 'active',
    comments,
  };
}

/** Parses the thread list `gh api graphql` returns for {@link LIST_THREADS_QUERY}. */
export function parseThreads(stdout: string): PrCommentThread[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const nodes = (
    parsed as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: GhThreadNode[] | null } };
        } | null;
      };
    }
  )?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }
  const threads: PrCommentThread[] = [];
  for (const node of nodes) {
    const mapped = mapThread(node);
    if (mapped) {
      threads.push(mapped);
    }
  }
  return threads;
}

/** Parses the PR node id from {@link pullNodeIdArgs}' response. */
export function parsePullNodeId(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const id = (
    parsed as {
      data?: { repository?: { pullRequest?: { id?: unknown } } | null };
    }
  )?.data?.repository?.pullRequest?.id;
  return typeof id === 'string' && id ? id : null;
}

/** Parses the created thread from {@link ADD_THREAD_MUTATION}'s response. */
export function parseAddedThread(stdout: string): PrCommentThread | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const node = (
    parsed as {
      data?: { addPullRequestReviewThread?: { thread?: GhThreadNode } | null };
    }
  )?.data?.addPullRequestReviewThread?.thread;
  return node ? mapThread(node) : null;
}

/** Parses the resolved/reopened thread state from a status mutation response. */
export function parseStatusResult(
  stdout: string,
  threadId: string,
  status: PrCommentThreadStatus,
): PrCommentThread {
  let isResolved = status === 'resolved';
  try {
    const parsed = JSON.parse(stdout) as {
      data?: Record<string, { thread?: { isResolved?: boolean } } | undefined>;
    };
    for (const value of Object.values(parsed?.data ?? {})) {
      if (value && typeof value.thread?.isResolved === 'boolean') {
        isResolved = value.thread.isResolved;
      }
    }
  } catch {
    // Fall back to the requested status when the response is unparsable.
  }
  return {
    id: threadId,
    path: null,
    line: null,
    status: isResolved ? 'resolved' : 'active',
    comments: [],
  };
}

/**
 * Builds a {@link PrCommentsGateway} for a GitHub pull request, driving every
 * operation through the `gh` CLI (the same login the IDE already holds). All
 * argv building and response parsing live in the pure helpers above so this
 * factory is a thin, exhaustively-tested orchestration layer.
 */
export function createGithubCommentsGateway(
  run: GhRunner,
  target: GithubPrTarget,
): PrCommentsGateway {
  const exec = async (args: string[], action: string): Promise<string> => {
    const res = await run(args);
    if (res.code !== 0) {
      throw new ProviderError(
        res.stderr.trim() || `Failed to ${action} on GitHub PR #${target.number}`,
      );
    }
    return res.stdout;
  };

  return {
    async list() {
      return parseThreads(await exec(listThreadsArgs(target), 'list comments'));
    },
    async add(input) {
      const pullNodeId = parsePullNodeId(
        await exec(pullNodeIdArgs(target), 'resolve pull id'),
      );
      if (!pullNodeId) {
        throw new ProviderError(
          `Could not resolve GitHub node id for PR #${target.number}`,
        );
      }
      const created = parseAddedThread(
        await exec(addThreadArgs(pullNodeId, input), 'post comment'),
      );
      if (!created) {
        throw new ProviderError('GitHub did not return the created comment.');
      }
      return created;
    },
    async setStatus(threadId, status) {
      const stdout = await exec(
        setStatusArgs(threadId, status),
        'update comment',
      );
      return parseStatusResult(stdout, threadId, status);
    },
  };
}
