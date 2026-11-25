export interface MetaOperation {
  execution?: {
    limited: boolean;
    attempts: { id: string; transport: 'session' | 'warm-acp'; createdAt: string;
      phases: { phase: 'admission' | 'preparing' | 'dispatched' | 'returned' | 'failed'; at: string }[] }[];
  };
  promptRefs?: readonly string[];
  correlation?: { runId: string; attachmentId?: string; perspectiveId?: string; contextFingerprint?: string; agentId?: string };
  operationId: string;
  featureId: string;
  automationId: string | null;
  originSessionId: string | null;
  providerId: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  sessionId: string | null;
  providerSessionId: string | null;
  sessionIds: string[];
  transport: 'unknown' | 'session' | 'warm-acp';
  state: 'pending' | 'running' | 'interrupted' | 'failed' | 'completed';
  outcome: 'not-dispatched' | 'unknown' | 'returned';
  purpose: string | null;
  label: string | null;
  resultText: string | null;
  errorMessage: string | null;
  usageState: 'unknown' | 'unsupported' | 'partial' | 'recorded';
  usage: { inputTokens: number | null; outputTokens: number | null; nanoAiu: number | null; credits: number | null } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export type MetaOperationSummary = Omit<MetaOperation, 'resultText'> & { hasResult: boolean };
export interface MetaOperationPage { items: MetaOperationSummary[]; nextCursor: string | null }
export interface MetaOperationsQuery {
  agentId?: string;
  runId?: string;
  from?: string;
  to?: string;
  featureId?: string;
  sessionId?: string;
  automationId?: string;
  after?: string | null;
  limit?: number;
}
