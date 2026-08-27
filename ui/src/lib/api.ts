import type {
  ConfigResponse,
  ConfigUpdateResult,
  MetaPoolsStatus,
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
  ImportableSession,
  ImportSessionInput,
  ModelInfo,
  MoveFeatureInput,
  MoveNodeInput,
  McpApplyResult,
  McpServerInput,
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
  ChangeGraphCategory,
  PrCommentThread,
  PrCommentThreadStatus,
  PrApprovalResult,
  PrDescriptionExportResult,
  ReviewBoard,
  ReviewBoardChatMessage,
  ReviewBoardChatReply,
  ReviewBoardChatContext,
  PerspectiveAnalysis,
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
  HealthStatus,
} from './types.js';

/** Injectable fetch so the client is unit-testable without a real network. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
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

  async function request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw new ApiError(response.status, await errorMessage(response, path));
    }
    return (await response.json()) as T;
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
    getRepoInsights: (id: string) =>
      request<RepoInsights>(`/repos/${id}/insights`),
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
    ) =>
      request<Feature>(
        `/repos/${repoId}/pulls`,
        jsonBody({ number, parentFeatureId: parentFeatureId ?? null }),
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
      })),
    deleteSession: (id: string) =>
      request<{ id: string }>(`/sessions/${id}`, del()),
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
    getMetaPools: () => request<MetaPoolsStatus>('/meta/pools'),
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
    runAutomation: (id: string) =>
      request<Automation>(`/automations/${id}/run`, jsonBody({})),
    deleteAutomation: (id: string) =>
      request<{ id: string }>(`/automations/${id}`, del()),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
