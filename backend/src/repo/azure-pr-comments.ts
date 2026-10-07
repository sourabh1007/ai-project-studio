import { ProviderError, ValidationError } from '../kernel/error-types.js';
import { assertExpectedHeadSha } from '../pr-review/pr-comment-location.js';
import { pullUrl } from './azure-pr-description.js';
import type {
  AzureHttpGetter,
  AzureHttpPatcher,
  AzureHttpPoster,
  AzureHttpPutter,
  AzureHttpDeleter,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import type { AzureRepoTarget } from './azure-pr-lister.js';
import type {
  AddPrCommentInput,
  PrComment,
  PrCommentThread,
  PrCommentThreadStatus,
  PrCommentsGateway,
  PrReaction,
} from '../pr-review/pr-comments-contract.js';

const API_VERSION = '7.1';

/** The org/project/repo and pull id an Azure comments gateway is bound to. */
export interface AzurePrTarget extends AzureRepoTarget {
  /** Azure `pullRequestId`. */
  pullRequestId: number;
}

/** The deps an Azure comments gateway needs: a token plus the verbs used. */
export interface AzureCommentsDeps {
  token: AzureTokenGetter;
  httpGet: AzureHttpGetter;
  httpPost: AzureHttpPoster;
  httpPatch: AzureHttpPatcher;
  httpPut: AzureHttpPutter;
  httpDelete: AzureHttpDeleter;
}

function threadsBase(target: AzurePrTarget): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/git/repositories` +
    `/${encodeURIComponent(target.repo)}/pullRequests` +
    `/${target.pullRequestId}/threads`
  );
}

/** REST URL listing / creating a pull request's comment threads. */
export function threadsUrl(target: AzurePrTarget): string {
  return `${threadsBase(target)}?api-version=${API_VERSION}`;
}

/** REST URL for one comment thread (used to PATCH its status). */
export function threadUrl(target: AzurePrTarget, threadId: string): string {
  return `${threadsBase(target)}/${encodeURIComponent(
    threadId,
  )}?api-version=${API_VERSION}`;
}

/** REST URL for liking / unliking a single comment within a thread. */
export function likesUrl(
  target: AzurePrTarget,
  threadId: string,
  commentId: string,
): string {
  return (
    `${threadsBase(target)}/${encodeURIComponent(threadId)}/comments` +
    `/${encodeURIComponent(commentId)}/likes?api-version=${API_VERSION}`
  );
}

/**
 * Azure thread status vocabulary is richer than our two-state model; only
 * `active` maps to "open". Anything else (`fixed`, `closed`, `wontFix`,
 * `byDesign`, `pending`) is treated as resolved so the panel's toggle is binary.
 */
export function mapAzureStatus(status: unknown): PrCommentThreadStatus {
  return status === 'active' ? 'active' : 'resolved';
}

/** The Azure status string to PATCH for a target two-state status. */
export function azureStatusValue(status: PrCommentThreadStatus): string {
  return status === 'resolved' ? 'closed' : 'active';
}

interface AdoCommentAuthor {
  displayName?: string;
  uniqueName?: string;
  imageUrl?: string;
}

interface AdoComment {
  id?: number;
  content?: string;
  publishedDate?: string;
  author?: AdoCommentAuthor | null;
  commentType?: string;
  usersLiked?: unknown[] | null;
}

interface AdoThreadContext {
  filePath?: string | null;
  rightFileStart?: { line?: number } | null;
}

interface AdoThread {
  id?: number;
  status?: string;
  isDeleted?: boolean;
  comments?: AdoComment[] | null;
  threadContext?: AdoThreadContext | null;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

/** Maps Azure's `usersLiked` array to our reaction model (like → 👍 only). */
export function mapLikes(usersLiked: unknown[] | null | undefined): PrReaction[] {
  const count = Array.isArray(usersLiked) ? usersLiked.length : 0;
  if (count === 0) {
    return [];
  }
  return [{ content: 'THUMBS_UP', count, viewerReacted: false }];
}

function mapComment(comment: AdoComment): PrComment | null {
  if (typeof comment?.id !== 'number') {
    return null;
  }
  return {
    id: String(comment.id),
    author:
      comment.author?.displayName ?? comment.author?.uniqueName ?? null,
    authorAvatarUrl: comment.author?.imageUrl ?? null,
    body: typeof comment.content === 'string' ? comment.content : '',
    createdAt:
      typeof comment.publishedDate === 'string' && comment.publishedDate
        ? comment.publishedDate
        : null,
    reactions: mapLikes(comment.usersLiked),
  };
}

/** Maps one Azure thread to our contract, or null when it should be hidden. */
export function mapThread(thread: AdoThread): PrCommentThread | null {
  if (typeof thread?.id !== 'number' || thread.isDeleted) {
    return null;
  }
  const comments: PrComment[] = [];
  for (const comment of thread.comments ?? []) {
    const mapped = mapComment(comment);
    if (mapped) {
      comments.push(mapped);
    }
  }
  // Threads with no non-deleted, user-authored comments are Azure system
  // events (status changes, votes) — skip them so the panel stays clean.
  if (comments.length === 0) {
    return null;
  }
  const filePath = thread.threadContext?.filePath;
  const line = thread.threadContext?.rightFileStart?.line;
  return {
    id: String(thread.id),
    path: typeof filePath === 'string' ? stripLeadingSlash(filePath) : null,
    line: typeof line === 'number' ? line : null,
    status: mapAzureStatus(thread.status),
    comments,
  };
}

/** Parses the `value[]` of thread objects Azure returns for the list call. */
export function parseThreads(body: unknown): PrCommentThread[] {
  const value = (body as { value?: unknown })?.value;
  if (!Array.isArray(value)) {
    return [];
  }
  const threads: PrCommentThread[] = [];
  for (const item of value as AdoThread[]) {
    const mapped = mapThread(item);
    if (mapped) {
      threads.push(mapped);
    }
  }
  return threads;
}

/** The request body creating a comment thread, inline or PR-level. */
export function buildAddThreadBody(input: AddPrCommentInput): unknown {
  if (input.path === undefined || input.line === undefined) {
    return {
      comments: [{ parentCommentId: 0, content: input.body, commentType: 'text' }],
      status: 'active',
    };
  }
  const filePath = input.path.startsWith('/') ? input.path : `/${input.path}`;
  return {
    comments: [{ parentCommentId: 0, content: input.body, commentType: 'text' }],
    status: 'active',
    threadContext: {
      filePath,
      rightFileStart: { line: input.line, offset: 1 },
      rightFileEnd: { line: input.line, offset: 1 },
    },
  };
}

/**
 * Builds a {@link PrCommentsGateway} for an Azure DevOps pull request, driving
 * every operation through the REST API with the OAuth token the IDE already
 * holds. Parsing/body-building live in the pure helpers above.
 */
export function createAzureCommentsGateway(
  deps: AzureCommentsDeps,
  target: AzurePrTarget,
): PrCommentsGateway {
  const authorize = async (): Promise<string> => {
    const token = await deps.token(target.org);
    if (!token) {
      throw new ProviderError(
        'Not signed in to Azure DevOps. Sign in first, then try again.',
      );
    }
    return token;
  };

  return {
    async list() {
      const token = await authorize();
      const res = await deps.httpGet(threadsUrl(target), token);
      if (res.status !== 200) {
        throw new ProviderError(
          `Failed to list Azure DevOps comments (HTTP ${res.status})`,
        );
      }
      return parseThreads(res.body);
    },
    async add(input) {
      if (input.expectedHeadSha !== undefined) assertExpectedHeadSha(input.expectedHeadSha);
      const token = await authorize();
      if (input.expectedHeadSha !== undefined) {
        const pull = await deps.httpGet(pullUrl(target), token);
        if (pull.status !== 200) {
          throw new ProviderError(`Failed to verify Azure DevOps PR head (HTTP ${pull.status})`);
        }
        const head = (pull.body as { lastMergeSourceCommit?: { commitId?: unknown } } | null)
          ?.lastMergeSourceCommit?.commitId;
        if (head !== input.expectedHeadSha) {
          throw new ValidationError('The live Azure DevOps PR head has changed or is unavailable. Refresh the Review Board before posting.');
        }
      }
      const res = await deps.httpPost(
        threadsUrl(target),
        token,
        buildAddThreadBody(input),
      );
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(
          `Failed to post Azure DevOps comment (HTTP ${res.status})`,
        );
      }
      const mapped = mapThread(res.body as AdoThread);
      if (!mapped) {
        throw new ProviderError(
          'Azure DevOps did not return the created comment.',
        );
      }
      return mapped;
    },
    async setStatus(threadId, status) {
      const token = await authorize();
      const res = await deps.httpPatch(threadUrl(target, threadId), token, {
        status: azureStatusValue(status),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(
          `Failed to update Azure DevOps comment (HTTP ${res.status})`,
        );
      }
      const mapped = mapThread(res.body as AdoThread);
      return (
        mapped ?? {
          id: threadId,
          path: null,
          line: null,
          status,
          comments: [],
        }
      );
    },
    async react(input) {
      if (input.content !== 'THUMBS_UP') {
        throw new ValidationError(
          'Azure DevOps pull-request comments only support the 👍 reaction.',
        );
      }
      const token = await authorize();
      const url = likesUrl(target, input.threadId, input.commentId);
      const res = input.on
        ? await deps.httpPut(url, token, {})
        : await deps.httpDelete(url, token);
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError(
          `Failed to react to Azure DevOps comment (HTTP ${res.status})`,
        );
      }
      return {
        id: input.commentId,
        author: null,
        authorAvatarUrl: null,
        body: '',
        createdAt: null,
        reactions: input.on
          ? [{ content: 'THUMBS_UP', count: 1, viewerReacted: true }]
          : [],
      };
    },
  };
}
