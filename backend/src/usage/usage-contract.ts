/** Canonical, provider-neutral usage record for one inference call (turn). */
export interface UsageEvent {
  sessionId: string;
  featureId: string;
  /** Stable application-assigned inference identity; never reindexed after pruning. */
  turnIndex: number;
  provider: string;
  requestedModel: string;
  /** Model actually used (resolved from 'auto' when applicable). */
  resolvedModel: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** Provider-reported cost in credits (github.copilot.cost). */
  cost: number;
  /** Raw AI usage units in nano-AIU (github.copilot.nano_aiu). */
  nanoAiu: number;
  serviceRequestId: string | null;
  startedAt: string;
  endedAt: string;
}
