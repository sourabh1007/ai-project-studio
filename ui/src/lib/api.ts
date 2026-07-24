import type {
  ConfigResponse,
  CreateFeatureInput,
  Feature,
  FeatureSummary,
  FeatureUsage,
  FeatureWorkSummary,
  ImportableSession,
  ImportSessionInput,
  ModelInfo,
  ProviderInfo,
  Session,
  StartSessionInput,
  StartTerminalSessionInput,
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
    getConfig: () => request<ConfigResponse>('/config'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
