import type {
  ConfigResponse,
  ConfigUpdateResult,
  AgentCatalogItem,
  AgentAttachment,
  AttachedAgent,
  AvailableAgent,
  MetaPoolsStatus,
  MetaSettings,
  MetaModelOption,
  CreateFeatureInput,
  CreateGroupInput,
  CreateSkillInput,
  AddFeatureTaskInput,
  AgencyStatus,
  AzureDevOpsStatus,
  DeviceCodeStart,
  DevicePollResult,
  Feature,
  FeatureSummary,
  FeatureTask,
  FeatureUsage,
  FeatureWorkSummary,
  GithubStatus,
  IdeUsage,
  IdeActivityFeed,
  UsageGranularity,
  UsageRollup,
  PlanUsageState,
  ImportableSession,
  ImportSessionInput,
  ModelInfo,
  MoveFeatureInput,
  MoveNodeInput,
  FeatureEnvironment,
  McpApplyResult,
  McpServerEntry,
  McpServerInput,
  McpServerStatus,
  ProviderInfo,
  ProviderMcpConfig,
  Repository,
  RepositoryContext,
  RepoInsights,
  RepoDefinitionContent,
  RemoteRepo,
  RemotePullRequest,
  PullFilter,
  PrReview,
  PrReviewStepKey,
  PrReviewChatMessage,
  PrReviewChatReply,
  PrReviewFileContent,
  ChangeGraphCategory,
  PrCommentThread,
  PrCommentThreadStatus,
  PrApprovalResult,
  PrDescriptionExportResult,
  ReviewBoard,
  ReviewBoardChatMessage,
  RefineChatMessage,
  BugBashRefineResult,
  NewTaskRefineResult,
  ReviewBoardChatReply,
  ReviewBoardChatContext,
  PerspectiveAnalysis,
  ReviewBoardPerspectiveEvent,
  NewTaskRun,
  NewTaskImplementEvent,
  NewTaskFileDiff,
  BugBashRun,
  BugBashInputs,
  BugBashStreamEvent,
  ManagedWorktree,
  AddPrCommentInput,
  AddRepositoryInput,
  Session,
  SessionFile,
  ContextScope,
  SharedContextDoc,
  Skill,
  SkillAttachment,
  SkillExport,
  SkillScope,
  StartSessionInput,
  StartTerminalSessionInput,
  TaggedSkill,
  TreeGroup,
  UpdateSkillInput,
  UsageTotals,
  StoredUsage,
  WorkspaceStats,
  Automation,
  AutomationDetail,
  Subagent,
  CreateAutomationInput,
  RunAutomationInput,
  HealthStatus,
} from './types.js';
import type {
  MetaOperation, MetaOperationPage, MetaOperationsQuery,
} from '../features/meta-operations/meta-operation-types.js';
import {
  validateMetaOperationPage,
  validateMetaPoolsStatus,
} from './response-contract.js';

/** Injectable fetch so the client is unit-testable without a real network. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Timeout (ms) applied to idempotent GET reads. Defaults to 20s. */
  getTimeoutMs?: number;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Typed client for the AI Project Studio backend API. */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? '/api';
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function errorMessage(
    response: Response,
    path: string,
  ): Promise<string> {
    try {
      const body = (await response.json()) as {
        error?: { message?: unknown };
      };
      const message = body?.error?.message;
      if (typeof message === 'string' && message.trim().length > 0) {
        return message;
      }
    } catch {
      // Non-JSON or empty error body; fall back to a generic message below.
    }
    return `Request failed: ${path}`;
  }

  /**
   * Read a New Task NDJSON stream, delivering each event to `onEvent`. Shared by
   * the plan and implement passes — both stream {activity|done|failed} lines
   * over a single long-lived socket.
   */
  async function streamNewTaskEvents(
    response: Response,
    path: string,
    onEvent: (event: NewTaskImplementEvent) => void,
  ): Promise<void> {
    if (!response.ok) {
      throw new ApiError(response.status, await errorMessage(response, path));
    }
    if (!response.body) {
      throw new ApiError(
        0,
        `Request failed: ${path} returned no stream. The backend may be starting up — please retry.`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flush = (chunk: string): void => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          onEvent(JSON.parse(line) as NewTaskImplementEvent);
        }
        newline = buffer.indexOf('\n');
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      onEvent(JSON.parse(tail) as NewTaskImplementEvent);
    }
  }

  /**
   * Read a Bug Bash NDJSON stream, delivering each event to `onEvent`. Shared by
   * the generate and run passes, which both stream {activity|agent|done|failed|
   * cancelled} lines over a single long-lived socket.
   */
  async function streamBugBashEvents(
    response: Response,
    path: string,
    onEvent: (event: BugBashStreamEvent) => void,
  ): Promise<void> {
    if (!response.ok) {
      throw new ApiError(response.status, await errorMessage(response, path));
    }
    if (!response.body) {
      throw new ApiError(
        0,
        `Request failed: ${path} returned no stream. The backend may be starting up — please retry.`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flush = (chunk: string): void => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          onEvent(JSON.parse(line) as BugBashStreamEvent);
        }
        newline = buffer.indexOf('\n');
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      onEvent(JSON.parse(tail) as BugBashStreamEvent);
    }
  }

  // Guard idempotent reads with a client-side timeout so a hung request (a
  // momentarily unresponsive backend, a dropped socket) surfaces as a
  // recoverable error instead of leaving the UI stuck on an infinite spinner.
  // Only GETs are bounded — mutations and AI turns (POST/PUT) can legitimately
  // run long, so they are never aborted here.
  const GET_TIMEOUT_MS = options.getTimeoutMs ?? 20_000;

  async function request<T>(
    path: string,
    init?: RequestInit,
    validate?: (body: unknown) => string | null,
  ): Promise<T> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const bounded = method === 'GET';
    const controller = bounded ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), GET_TIMEOUT_MS)
      : undefined;
    const timedOut = () =>
      new ApiError(
        0,
        `Request timed out: ${path}. The backend may be busy — please retry.`,
      );
    try {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          ...init,
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (error) {
        if (controller?.signal.aborted) {
          throw timedOut();
        }
        throw error;
      }
      if (!response.ok) {
        throw new ApiError(response.status, await errorMessage(response, path));
      }
      // The body is read inside the timeout as well. Clearing the timer once
      // the headers arrived left a backend that died mid-response able to hang
      // this read forever, which is what stranded views on their skeletons
      // with no error and no way to retry.
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (controller?.signal.aborted) {
          throw timedOut();
        }
        // A 200 that is not JSON is almost always something other than our
        // backend answering (a proxy page, a partly started shell).
        throw new ApiError(
          0,
          `Request failed: ${path} did not return JSON. The backend may be starting up — please retry.`,
        );
      }
      if (validate) {
        const problem = validate(body);
        if (problem) {
          throw new ApiError(0, problem);
        }
      }
      return body as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  function jsonBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  function putBody(body: unknown): RequestInit {
    return {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  function del(): RequestInit {
    return { method: 'DELETE' };
  }

  return {
    listMetaOperations: (query: MetaOperationsQuery = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value != null) params.set(key, String(value));
      }
      const suffix = params.toString();
      return request<MetaOperationPage>(
        `/meta/operations${suffix ? `?${suffix}` : ''}`,
        undefined,
        validateMetaOperationPage,
      );
    },
    getMetaOperation: (operationId: string) =>
      request<MetaOperation>(`/meta/operations/${encodeURIComponent(operationId)}`),
    checkHealth: () => request<HealthStatus>('/health'),
    listRepos: () => request<Repository[]>('/repos'),
    addRepo: (input: AddRepositoryInput) =>
      request<Repository>('/repos', jsonBody(input)),
    deleteRepo: (id: string) =>
      request<{ id: string }>(`/repos/${id}`, del()),
    getRepositoryContext: (id: string) =>
      request<RepositoryContext>(`/repos/${id}/context`),
    refreshRepositoryContext: (id: string) =>
      request<RepositoryContext>(
        `/repos/${id}/context/refresh`,
        jsonBody({}),
      ),
    getRepoInsights: (id: string, refresh = false) =>
      request<RepoInsights>(
        `/repos/${id}/insights${refresh ? '?refresh=true' : ''}`,
      ),
    getRepoDefinition: (id: string, path: string) =>
      request<RepoDefinitionContent>(
        `/repos/${id}/insights/file?path=${encodeURIComponent(path)}`,
      ),
    listGithubRepos: () =>
      request<RemoteRepo[]>('/providers/github/repos'),
    listAzureRepos: (org: string) =>
      request<RemoteRepo[]>(
        `/providers/azure-devops/repos?org=${encodeURIComponent(org)}`,
      ),
    listRepoPulls: (repoId: string, filter: PullFilter = 'all') =>
      request<RemotePullRequest[]>(
        `/repos/${repoId}/pulls?filter=${filter}`,
      ),
    createPrFeature: (
      repoId: string,
      number: number,
      parentFeatureId?: string | null,
      parentGroupId?: string | null,
    ) =>
      request<Feature>(
        `/repos/${repoId}/pulls`,
        jsonBody({
          number,
          parentFeatureId: parentFeatureId ?? null,
          parentGroupId: parentGroupId ?? null,
        }),
      ),
    getPrReview: (featureId: string) =>
      request<PrReview>(`/features/${featureId}/pr-review`),
    getReviewBoard: (featureId: string) =>
      request<ReviewBoard>(`/features/${featureId}/review-board`),
    analyzeReviewBoard: (featureId: string) =>
      request<ReviewBoard>(
        `/features/${featureId}/review-board/analyze`,
        jsonBody({}),
      ),
    analyzeReviewBoardPerspective: (
      featureId: string,
      perspectiveId: string,
      signal?: AbortSignal,
    ) =>
      request<PerspectiveAnalysis>(
        `/features/${featureId}/review-board/perspectives/${perspectiveId}/analyze`,
        { ...jsonBody({}), signal },
      ),
    // Server-side fan-out: one long-lived POST whose body is a stream of
    // newline-delimited JSON ReviewBoardPerspectiveEvents. The whole parallel
    // pass runs on the backend (bounded by the warm pool, reserving one
    // session), so the browser holds a single socket for the entire board
    // instead of one per perspective. Each event is delivered to `onEvent` as
    // it arrives; resolves when the stream ends (or the signal aborts).
    analyzeReviewBoardPerspectives: async (
      featureId: string,
      onEvent: (event: ReviewBoardPerspectiveEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const path = `/features/${featureId}/review-board/analyze-perspectives`;
      const response = await doFetch(`${baseUrl}${path}`, {
        ...jsonBody({}),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        throw new ApiError(response.status, await errorMessage(response, path));
      }
      if (!response.body) {
        throw new ApiError(
          0,
          `Request failed: ${path} returned no stream. The backend may be starting up — please retry.`,
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const flush = (chunk: string): void => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            onEvent(JSON.parse(line) as ReviewBoardPerspectiveEvent);
          }
          newline = buffer.indexOf('\n');
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        flush(decoder.decode(value, { stream: true }));
      }
      const tail = buffer.trim();
      if (tail.length > 0) {
        onEvent(JSON.parse(tail) as ReviewBoardPerspectiveEvent);
      }
    },
    chatReviewBoard: (
      featureId: string,
      perspectiveId: string | null,
      messages: ReviewBoardChatMessage[],
      context?: ReviewBoardChatContext | null,
    ) =>
      request<ReviewBoardChatReply>(
        `/features/${featureId}/review-board/chat`,
        jsonBody({ perspectiveId, messages, context: context ?? null }),
      ),
    getNewTask: (featureId: string, attachmentId: string) =>
      request<{ run: NewTaskRun | null }>(
        `/features/${featureId}/new-task/${attachmentId}`,
      ),
    getNewTaskFileDiff: (
      featureId: string,
      attachmentId: string,
      path: string,
    ) =>
      request<NewTaskFileDiff>(
        `/features/${featureId}/new-task/${attachmentId}/file-diff` +
          `?path=${encodeURIComponent(path)}`,
      ),
    saveNewTaskInputs: (
      featureId: string,
      attachmentId: string,
      inputs: { problem: string; context: string },
    ) =>
      request<NewTaskRun>(
        `/features/${featureId}/new-task/${attachmentId}/inputs`,
        jsonBody(inputs),
      ),
    planNewTask: async (
      featureId: string,
      attachmentId: string,
      onEvent: (event: NewTaskImplementEvent) => void,
      signal?: AbortSignal,
      options?: { baseBranch?: string; suggestion?: string },
    ): Promise<void> => {
      const path = `/features/${featureId}/new-task/${attachmentId}/plan`;
      const response = await doFetch(`${baseUrl}${path}`, {
        ...jsonBody(options ?? {}),
        ...(signal ? { signal } : {}),
      });
      await streamNewTaskEvents(response, path, onEvent);
    },
    // Long-lived POST whose body is a stream of newline-delimited JSON
    // NewTaskImplementEvents: the implement turn, PR creation and Review-Board
    // conversion all run on the backend behind a single socket. Each event is
    // delivered to `onEvent` as it arrives; resolves when the stream ends.
    implementNewTask: async (
      featureId: string,
      attachmentId: string,
      onEvent: (event: NewTaskImplementEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const path = `/features/${featureId}/new-task/${attachmentId}/implement`;
      const response = await doFetch(`${baseUrl}${path}`, {
        ...jsonBody({}),
        ...(signal ? { signal } : {}),
      });
      await streamNewTaskEvents(response, path, onEvent);
    },
    // Reconnect (GET) to a New Task run already in flight so a window returning
    // after a switch resumes the live logs. Replays buffered events then tails
    // live ones; ends immediately with no events when no run is active, letting
    // the caller fall back to its "interrupted — resume" affordance.
    streamNewTask: async (
      featureId: string,
      attachmentId: string,
      onEvent: (event: NewTaskImplementEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const path = `/features/${featureId}/new-task/${attachmentId}/stream`;
      const response = await doFetch(`${baseUrl}${path}`, {
        ...(signal ? { signal } : {}),
      });
      await streamNewTaskEvents(response, path, onEvent);
    },
    // Cancel-and-reset an in-flight New Task run: aborts the background
    // metasession (terminating any attached agent process) and resets the run
    // to a clean draft. Returns whether a live run was cancelled plus the reset
    // run (or null when none existed).
    cancelNewTask: (featureId: string, attachmentId: string) =>
      request<{ cancelled: boolean; run: NewTaskRun | null }>(
        `/features/${featureId}/new-task/${attachmentId}/cancel`,
        jsonBody({}),
      ),
    // One New Task plan refine-chat turn: post the full prior conversation plus
    // the new message; the server runs a single AI turn and returns the reply
    // plus the run, with the plan replaced when the turn revised it.
    refineNewTask: (
      featureId: string,
      attachmentId: string,
      history: RefineChatMessage[],
      message: string,
    ) =>
      request<NewTaskRefineResult>(
        `/features/${featureId}/new-task/${attachmentId}/refine`,
        jsonBody({ history, message }),
      ),
    getBugBash: (featureId: string, attachmentId: string) =>
      request<{ run: BugBashRun | null }>(
        `/features/${featureId}/bug-bash/${attachmentId}`,
      ),
    saveBugBashInputs: (
      featureId: string,
      attachmentId: string,
      inputs: BugBashInputs,
    ) =>
      request<BugBashRun>(
        `/features/${featureId}/bug-bash/${attachmentId}/inputs`,
        jsonBody(inputs),
      ),
    // Dynamically identify the information the bug bash still needs to run its
    // scenarios successfully, returning the run with freshly-generated
    // prerequisite questions for the user to answer.
    generateBugBashPrerequisites: (featureId: string, attachmentId: string) =>
      request<BugBashRun>(
        `/features/${featureId}/bug-bash/${attachmentId}/prerequisites`,
        jsonBody({}),
      ),
    // Persist the user's answers to the generated prerequisite questions.
    saveBugBashPrerequisiteAnswers: (
      featureId: string,
      attachmentId: string,
      answers: { id: string; answer: string }[],
    ) =>
      request<BugBashRun>(
        `/features/${featureId}/bug-bash/${attachmentId}/prerequisites/answers`,
        jsonBody({ answers }),
      ),
    // Long-lived POST that generates the reviewable scenarios in the background
    // (via the run hub) and streams newline-delimited progress events. Survives
    // this socket closing; reconnect with streamBugBash to keep watching.
    generateBugBash: async (
      featureId: string,
      attachmentId: string,
      onEvent: (event: BugBashStreamEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const path = `/features/${featureId}/bug-bash/${attachmentId}/generate`;
      const response = await doFetch(`${baseUrl}${path}`, {
        ...jsonBody({}),
        ...(signal ? { signal } : {}),
      });
      await streamBugBashEvents(response, path, onEvent);
    },
    // Long-lived POST that runs the accepted scenarios across the tester team
    // and compiles the report, streaming live agent + activity events.
    runBugBash: async (
      featureId: string,
      attachmentId: string,
      onEvent: (event: BugBashStreamEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const path = `/features/${featureId}/bug-bash/${attachmentId}/run`;
      const response = await doFetch(`${baseUrl}${path}`, {
        ...jsonBody({}),
        ...(signal ? { signal } : {}),
      });
      await streamBugBashEvents(response, path, onEvent);
    },
    // Reconnect (GET) to a Bug Bash pass already in flight so a window returning
    // after a switch resumes the live logs. Ends immediately with no events when
    // no pass is active, letting the caller fall back to its resume affordance.
    streamBugBash: async (
      featureId: string,
      attachmentId: string,
      onEvent: (event: BugBashStreamEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> => {
      const path = `/features/${featureId}/bug-bash/${attachmentId}/stream`;
      const response = await doFetch(`${baseUrl}${path}`, {
        ...(signal ? { signal } : {}),
      });
      await streamBugBashEvents(response, path, onEvent);
    },
    // Cancel-and-reset an in-flight Bug Bash pass: aborts the background
    // metasession (terminating any attached agent process) and resets the run.
    cancelBugBash: (featureId: string, attachmentId: string) =>
      request<{ cancelled: boolean; run: BugBashRun | null }>(
        `/features/${featureId}/bug-bash/${attachmentId}/cancel`,
        jsonBody({}),
      ),
    // One Bug Bash scenario refine-chat turn: post the full prior conversation
    // plus the new message; the server runs a single AI turn and returns the
    // reply plus the run, with the scenarios replaced when the turn revised them.
    refineBugBash: (
      featureId: string,
      attachmentId: string,
      history: RefineChatMessage[],
      message: string,
    ) =>
      request<BugBashRefineResult>(
        `/features/${featureId}/bug-bash/${attachmentId}/refine`,
        jsonBody({ history, message }),
      ),
    refreshPrReview: (featureId: string) =>
      request<PrReview>(
        `/features/${featureId}/pr-review/refresh`,
        jsonBody({}),
      ),
    pullLatestPrReview: (featureId: string) =>
      request<PrReview>(
        `/features/${featureId}/pr-review/pull-latest`,
        jsonBody({}),
      ),
    retryPrReviewStep: (featureId: string, step: PrReviewStepKey) =>
      request<PrReview>(
        `/features/${featureId}/pr-review/steps/${step}/retry`,
        jsonBody({}),
      ),
    explainPrReviewFile: (featureId: string, path: string) =>
      request<PrReview>(
        `/features/${featureId}/pr-review/files/explain`,
        jsonBody({ path }),
      ),
    getPrReviewFileContent: (featureId: string, path: string) =>
      request<PrReviewFileContent>(
        `/features/${featureId}/pr-review/files/content?path=${encodeURIComponent(
          path,
        )}`,
      ),
    chatPrReviewGraph: (
      featureId: string,
      category: ChangeGraphCategory,
      messages: PrReviewChatMessage[],
    ) =>
      request<PrReviewChatReply>(
        `/features/${featureId}/pr-review/graph-chat`,
        jsonBody({ category, messages }),
      ),
    listPrReviewComments: (featureId: string) =>
      request<PrCommentThread[]>(
        `/features/${featureId}/pr-review/comments`,
      ),
    addPrReviewComment: (featureId: string, input: AddPrCommentInput) =>
      request<PrCommentThread>(
        `/features/${featureId}/pr-review/comments`,
        jsonBody(input),
      ),
    setPrReviewCommentStatus: (
      featureId: string,
      threadId: string,
      status: PrCommentThreadStatus,
    ) =>
      request<PrCommentThread>(
        `/features/${featureId}/pr-review/comments/${threadId}/status`,
        jsonBody({ status }),
      ),
    approvePrReview: (featureId: string) =>
      request<PrApprovalResult>(
        `/features/${featureId}/pr-review/approve`,
        jsonBody({}),
      ),
    exportPrReviewDescription: (featureId: string) =>
      request<PrDescriptionExportResult>(
        `/features/${featureId}/pr-review/export-description`,
        jsonBody({}),
      ),
    listWorktrees: () => request<ManagedWorktree[]>('/worktrees'),
    removeWorktree: (path: string) =>
      request<{ removed: true }>('/worktrees/remove', jsonBody({ path })),
    listFeatures: () => request<Feature[]>('/features'),
    getFeature: (id: string) => request<Feature>(`/features/${id}`),
    createFeature: (input: CreateFeatureInput) =>
      request<Feature>('/features', jsonBody(input)),
    renameFeature: (id: string, name: string) =>
      request<Feature>(`/features/${id}`, putBody({ name })),
    deleteFeature: (id: string) =>
      request<{ id: string }>(`/features/${id}`, del()),
    moveFeature: (input: MoveFeatureInput) =>
      request<Feature>(`/features/${input.id}/move`, jsonBody({
        targetRepoId: input.targetRepoId,
        targetIndex: input.targetIndex,
        targetParentFeatureId: input.targetParentFeatureId ?? null,
        targetParentGroupId: input.targetParentGroupId ?? null,
      })),
    deleteSession: (id: string) =>
      request<{ id: string }>(`/sessions/${id}`, del()),
    relaunchSession: (id: string) =>
      request<Session>(`/sessions/${id}/relaunch`, jsonBody({})),
    getSession: (id: string) => request<Session>(`/sessions/${id}`),
    getFeatureEnvironment: (featureId: string) =>
      request<FeatureEnvironment>(`/features/${featureId}/environment`),
    renameSession: (id: string, name: string | null) =>
      request<Session>(`/sessions/${id}`, putBody({ name })),
    listSessions: (
      featureId: string,
      options: { includeInternal?: boolean } = {},
    ) =>
      request<Session[]>(
        `/features/${featureId}/sessions${
          options.includeInternal ? '?includeInternal=true' : ''
        }`,
      ),
    listGroups: (featureId: string) =>
      request<TreeGroup[]>(`/features/${featureId}/groups`),
    createGroup: (featureId: string, input: CreateGroupInput) =>
      request<TreeGroup>(`/features/${featureId}/groups`, jsonBody(input)),
    renameGroup: (groupId: string, name: string) =>
      request<TreeGroup>(`/groups/${groupId}`, putBody({ name })),
    deleteGroup: (groupId: string) =>
      request<{ id: string }>(`/groups/${groupId}`, del()),
    moveNode: (input: MoveNodeInput) =>
      request<{ moved: boolean }>('/tree/move', jsonBody(input)),
    startSession: (featureId: string, input: StartSessionInput) =>
      request<Session>(`/features/${featureId}/sessions`, jsonBody(input)),
    createTerminalSession: (
      featureId: string,
      input: StartTerminalSessionInput,
    ) =>
      request<Session>(
        `/features/${featureId}/terminal-sessions`,
        jsonBody(input),
      ),
    getFeatureUsage: (featureId: string) =>
      request<FeatureUsage>(`/features/${featureId}/usage`),
    getSessionUsageEvents: (sessionId: string) =>
      request<StoredUsage[]>(`/sessions/${sessionId}/usage`),
    getFeatureUsageEvents: (featureId: string) =>
      request<StoredUsage[]>(`/features/${featureId}/usage/events`),
    getRepoUsageEvents: (repoId: string) =>
      request<StoredUsage[]>(`/repos/${repoId}/usage/events`),
    getWorkspaceTotals: () => request<UsageTotals>('/usage/totals'),
    getWorkspaceStats: () => request<WorkspaceStats>('/usage/workspace'),
    getIdeUsage: () => request<IdeUsage>('/usage/ide'),
    getUsageRollup: (granularity: UsageGranularity) =>
      request<UsageRollup>(`/usage/rollup?granularity=${granularity}`),
    getIdeUsageRollup: (granularity: UsageGranularity) =>
      request<UsageRollup>(`/usage/ide/rollup?granularity=${granularity}`),
    getIdeActivity: () => request<IdeActivityFeed>('/usage/ide/activity'),
    getFeatureUsageRollup: (featureId: string, granularity: UsageGranularity) =>
      request<UsageRollup>(
        `/features/${featureId}/usage/rollup?granularity=${granularity}`,
      ),
    getPlanUsage: () => request<PlanUsageState>('/usage/plan'),
    generateSummary: (featureId: string) =>
      request<FeatureSummary>(
        `/features/${featureId}/summary`,
        jsonBody({}),
      ),
    getSummary: (featureId: string) =>
      request<FeatureSummary>(`/features/${featureId}/summary`),
    getFeatureWorkSummary: (featureId: string) =>
      request<FeatureWorkSummary>(`/features/${featureId}/work-summary`),
    listProviders: () => request<ProviderInfo[]>('/providers'),
    listImportableSessions: () =>
      request<ImportableSession[]>('/importable-sessions'),
    importSession: (featureId: string, input: ImportSessionInput) =>
      request<Session>(
        `/features/${featureId}/import-session`,
        jsonBody(input),
      ),
    listModels: (providerId: string) =>
      request<ModelInfo[]>(`/providers/${providerId}/models`),
    listMcpProviders: () => request<ProviderInfo[]>('/mcp/providers'),
    getMcpServers: (providerId: string) =>
      request<ProviderMcpConfig>(
        `/mcp/providers/${encodeURIComponent(providerId)}/servers`,
      ),
    inspectMcpServer: (providerId: string, serverName: string) =>
      request<McpServerEntry>(
        `/mcp/providers/${encodeURIComponent(providerId)}/servers/${encodeURIComponent(serverName)}/tools`,
      ),
    getMcpServerStatus: (providerId: string, serverName: string) =>
      request<McpServerStatus>(
        `/mcp/providers/${encodeURIComponent(providerId)}/servers/${encodeURIComponent(serverName)}/status`,
      ),
    putMcpServer: (providerId: string, input: McpServerInput) =>
      request<ProviderMcpConfig>(
        `/mcp/providers/${encodeURIComponent(providerId)}/servers`,
        putBody(input),
      ),
    setMcpToolEnabled: (
      providerId: string,
      serverName: string,
      toolName: string,
      enabled: boolean,
    ) =>
      request<McpApplyResult>(
        `/mcp/providers/${encodeURIComponent(providerId)}/servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}`,
        putBody({ enabled }),
      ),
    restartMcpServer: (providerId: string, serverName: string) =>
      request<McpApplyResult>(
        `/mcp/providers/${encodeURIComponent(providerId)}/servers/${encodeURIComponent(serverName)}/restart`,
        jsonBody({}),
      ),
    listSkills: () => request<Skill[]>('/skills'),
    getSkill: (id: string) => request<Skill>(`/skills/${id}`),
    createSkill: (input: CreateSkillInput) =>
      request<Skill>('/skills', jsonBody(input)),
    updateSkill: (id: string, input: UpdateSkillInput) =>
      request<Skill>(`/skills/${id}`, putBody(input)),
    deleteSkill: (id: string) =>
      request<{ id: string }>(`/skills/${id}`, del()),
    tagSkill: (id: string, scope: SkillScope, targetId: string) =>
      request<SkillAttachment>(
        `/skills/${id}/attachments`,
        jsonBody({ scope, targetId }),
      ),
    untagSkill: (attachmentId: string) =>
      request<{ id: string }>(`/skills/attachments/${attachmentId}`, del()),
    listFeatureSkills: (featureId: string) =>
      request<TaggedSkill[]>(`/features/${featureId}/skills`),
    listSessionSkills: (sessionId: string) =>
      request<TaggedSkill[]>(`/sessions/${sessionId}/skills`),
    listSessionFiles: (sessionId: string) =>
      request<SessionFile[]>(`/sessions/${sessionId}/files`),
    getSharedContext: async (scope: ContextScope, scopeId: string) => {
      const query = scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : '';
      try {
        return await request<SharedContextDoc>(`/context/${scope}${query}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    saveSharedContext: (scope: ContextScope, scopeId: string, content: string) =>
      request<SharedContextDoc>(
        `/context/${scope}`,
        putBody({ scopeId, content }),
      ),
    rememberSharedContext: (scope: ContextScope, scopeId: string, text: string) =>
      request<SharedContextDoc>(
        `/context/${scope}/remember`,
        jsonBody({ scopeId, text }),
      ),
    exportSkill: (id: string) => request<SkillExport>(`/skills/${id}/export`),
    exportSkills: () => request<SkillExport[]>('/skills/export'),
    importSkill: (payload: SkillExport) =>
      request<Skill>('/skills/import', jsonBody(payload)),
    listFeatureTasks: (featureId: string) =>
      request<FeatureTask[]>(`/features/${featureId}/tasks`),
    generateFeatureTasks: (featureId: string) =>
      request<FeatureTask[]>(`/features/${featureId}/tasks/generate`, jsonBody({})),
    addFeatureTask: (featureId: string, input: AddFeatureTaskInput) =>
      request<FeatureTask>(`/features/${featureId}/tasks`, jsonBody(input)),
    toggleFeatureTask: (taskId: string) =>
      request<FeatureTask>(`/tasks/${taskId}`, putBody({})),
    removeFeatureTask: (taskId: string) =>
      request<{ id: string }>(`/tasks/${taskId}`, del()),
    listAgents: () => request<AgentCatalogItem[]>('/agents'),
    getAgent: (agentId: string) =>
      request<AgentCatalogItem>(`/agents/${encodeURIComponent(agentId)}`),
    listFeatureAgents: (featureId: string) =>
      request<AttachedAgent[]>(`/features/${featureId}/agents`),
    listAvailableAgents: (featureId: string) =>
      request<AvailableAgent[]>(`/features/${featureId}/agents/available`),
    attachAgent: (featureId: string, agentId: string) =>
      request<AgentAttachment>(
        `/features/${featureId}/agents`,
        jsonBody({ agentId }),
      ),
    detachAgent: (attachmentId: string) =>
      request<{ id: string }>(`/agents/attachments/${attachmentId}`, del()),
    getConfig: () => request<ConfigResponse>('/config'),
    updateConfig: (namespace: string, values: Record<string, unknown>) =>
      request<ConfigUpdateResult>(
        `/config/${encodeURIComponent(namespace)}`,
        putBody({ values }),
      ),
    resetConfig: (namespace: string) =>
      request<ConfigUpdateResult>(
        `/config/${encodeURIComponent(namespace)}`,
        del(),
      ),
    getMetaPools: () =>
      request<MetaPoolsStatus>('/meta/pools', undefined, validateMetaPoolsStatus),
    resizeMetaPool: (size: number) =>
      request<MetaPoolsStatus>(
        '/meta/pools/resize',
        jsonBody({ size }),
        validateMetaPoolsStatus,
      ),
    getMetaSettings: () => request<MetaSettings>('/meta/settings'),
    updateMetaSettings: (patch: Partial<Pick<MetaSettings, 'providerId' | 'model'>>) =>
      request<MetaSettings>('/meta/settings', putBody(patch)),
    getMetaModels: () => request<MetaModelOption[]>('/meta/models'),
    askSettingsAssistant: (input: {
      namespace: string;
      key?: string;
      question: string;
    }) =>
      request<{ answer: string }>('/config/assistant', jsonBody(input)),
    getAgencyStatus: () => request<AgencyStatus>('/agency/status'),
    getGithubStatus: () => request<GithubStatus>('/github/status'),
    githubSignInStart: () =>
      request<DeviceCodeStart>('/github/signin/start', jsonBody({})),
    githubSignInPoll: (deviceCode: string) =>
      request<DevicePollResult>(
        '/github/signin/poll',
        jsonBody({ deviceCode }),
      ),
    githubSignOut: () =>
      request<GithubStatus>('/github/signout', jsonBody({})),
    getAzureStatus: (url?: string) =>
      request<AzureDevOpsStatus>(
        `/azure-devops/status${url ? `?url=${encodeURIComponent(url)}` : ''}`,
      ),
    azureSignIn: (url?: string) =>
      request<AzureDevOpsStatus>(
        '/azure-devops/signin',
        jsonBody(url ? { url } : {}),
      ),
    azureSignOut: (url?: string) =>
      request<AzureDevOpsStatus>(
        '/azure-devops/signout',
        jsonBody(url ? { url } : {}),
      ),
    listAutomations: () =>
      request<{ automations: Automation[]; subagents: Subagent[] }>(
        '/automations',
      ),
    getAutomation: (id: string) =>
      request<AutomationDetail>(`/automations/${id}`),
    createAutomation: (input: CreateAutomationInput) =>
      request<Automation>('/automations', jsonBody(input)),
    pauseAutomation: (id: string) =>
      request<Automation>(`/automations/${id}/pause`, jsonBody({})),
    resumeAutomation: (id: string) =>
      request<Automation>(`/automations/${id}/resume`, jsonBody({})),
    cancelAutomation: (id: string) =>
      request<Automation>(`/automations/${id}/cancel`, jsonBody({})),
    runAutomation: (id: string, input?: RunAutomationInput) =>
      request<Automation>(`/automations/${id}/run`, jsonBody(input ?? {})),
    updateAutomationInterval: (id: string, intervalMs: number) =>
      request<Automation>(
        `/automations/${id}/interval`,
        jsonBody({ intervalMs }),
      ),
    deleteAutomation: (id: string) =>
      request<{ id: string }>(`/automations/${id}`, del()),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
