export interface ActiveSessionEntry {
  id: string;
  sessionId: string | null;
  kind: 'session' | 'meta';
  state: 'running' | 'busy' | 'idle' | 'warming' | 'stopping';
  transport: 'session' | 'warm-acp';
  label: string;
  purpose: string | null;
  featureId: string | null;
  featureName: string | null;
  projectName: string | null;
  operationId: string | null;
  provider: string | null;
  model: string | null;
}

export interface ActiveSessionsSnapshot {
  sampledAt: number;
  pollMs: number;
  entries: ActiveSessionEntry[];
}

export interface ActiveSessionDebug {
  sampledAt: number;
  entry: ActiveSessionEntry | null;
  state: string;
  activity: string[];
  output: string;
  error: string | null;
  truncated: boolean;
}

export interface ActiveSessionsApi {
  getActiveSessions(options?: { signal?: AbortSignal }): Promise<ActiveSessionsSnapshot>;
  getActiveSessionDebug(id: string, options?: { signal?: AbortSignal }): Promise<ActiveSessionDebug>;
}
