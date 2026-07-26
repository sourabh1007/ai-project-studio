import type {
  ConfigResponse,
  CreateFeatureInput,
  CreateSkillInput,
  AddFeatureTaskInput,
  AgencyStatus,
  Feature,
  FeatureSummary,
  FeatureTask,
  FeatureUsage,
  FeatureWorkSummary,
  IdeUsage,
  ImportableSession,
  ImportSessionInput,
  ModelInfo,
  ProviderInfo,
  Session,
  SessionFile,
  Skill,
  SkillAttachment,
  SkillExport,
  SkillScope,
  StartSessionInput,
  StartTerminalSessionInput,
  TaggedSkill,
  UpdateSkillInput,
  UsageTotals,
  WorkspaceStats,
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

  async function request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw new ApiError(response.status, `Request failed: ${path}`);
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
    listFeatures: () => request<Feature[]>('/features'),
    getFeature: (id: string) => request<Feature>(`/features/${id}`),
    createFeature: (input: CreateFeatureInput) =>
      request<Feature>('/features', jsonBody(input)),
    renameFeature: (id: string, name: string) =>
      request<Feature>(`/features/${id}`, putBody({ name })),
    deleteFeature: (id: string) =>
      request<{ id: string }>(`/features/${id}`, del()),
    deleteSession: (id: string) =>
      request<{ id: string }>(`/sessions/${id}`, del()),
    renameSession: (id: string, name: string | null) =>
      request<Session>(`/sessions/${id}`, putBody({ name })),
    listSessions: (featureId: string) =>
      request<Session[]>(`/features/${featureId}/sessions`),
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
    getAgencyStatus: () => request<AgencyStatus>('/agency/status'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
