export interface MetaOperation {
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
  featureId?: string;
  sessionId?: string;
  automationId?: string;
  after?: string | null;
  limit?: number;
}
