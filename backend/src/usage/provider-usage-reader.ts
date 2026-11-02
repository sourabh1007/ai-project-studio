import type { UsageCaptureRead } from './usage-capture-contract.js';

export interface ProviderUsageSample {
  nativeSessionId: string;
  nativeMessageId: string;
  scope: 'message' | 'session';
  model: string | null;
  /** Uncached input only; separately reported cache counts are disjoint. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  charge: { status: 'estimated'; unit: 'USD'; amount: number; scope: 'session' } | { status: 'unavailable' };
}

export interface ProviderUsagePage {
  samples: readonly ProviderUsageSample[];
  nextCursor: string | null;
  highWaterCursor?: string | null;
}

export interface ProviderUsageReaderDeps {
  provider: string;
  sourceId: string;
  session: { id: string; featureId: string; requestedModel: string; createdAt: string };
  /** Reads an already bounded, worker-populated cache, never parses logs on HTTP. */
  readPage(cursor: string | null, limit: number): ProviderUsagePage | null;
}

/** Native identities, not log offsets, survive resume, subagents and corrections. */
export function createProviderUsageReader(deps: ProviderUsageReaderDeps) {
  return (cursor: string | null, limit: number): UsageCaptureRead => {
    const page = deps.readPage(cursor, limit);
    if (!page) return { status: 'retrying', sourceId: deps.sourceId, reason: 'provider-cache-unavailable' };
    return {
      status: 'ready', sourceId: deps.sourceId, nextCursor: page.nextCursor, final: false,
      highWaterCursor: page.highWaterCursor,
      rows: page.samples.flatMap((sample) => {
        const cumulative = sample.scope === 'session';
        // A cumulative result may repeat prior spend on resume. One replaceable
        // charge-only row per native session prevents summing result snapshots.
        if (cumulative && sample.charge.status === 'unavailable') return [];
        if (!cumulative && (sample.inputTokens === null || sample.outputTokens === null)) return [];
        const nativeMessageId = cumulative ? 'session-charge-estimate' : sample.nativeMessageId;
        return [{
          sourceKey: JSON.stringify([deps.provider, sample.nativeSessionId, sample.scope, nativeMessageId]),
          event: {
            sessionId: deps.session.id, featureId: deps.session.featureId, turnIndex: 0,
            provider: deps.provider, requestedModel: deps.session.requestedModel,
            resolvedModel: sample.model ?? deps.session.requestedModel,
            operation: cumulative ? 'session-charge-estimate' : 'inference',
            inputTokens: cumulative ? 0 : sample.inputTokens! + (sample.cacheReadTokens ?? 0) + (sample.cacheWriteTokens ?? 0),
            outputTokens: cumulative ? 0 : sample.outputTokens!, reasoningOutputTokens: 0,
            cost: null, nanoAiu: null, chargeProvenance: sample.charge.status,
            chargeUnit: null, usdEstimate: sample.charge.status === 'estimated' ? sample.charge.amount : null,
            nativeSessionId: sample.nativeSessionId, nativeMessageId,
            serviceRequestId: null, startedAt: deps.session.createdAt, endedAt: deps.session.createdAt,
          },
        }];
      }),
    };
  };
}
