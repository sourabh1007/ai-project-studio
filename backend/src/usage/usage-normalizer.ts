import { hrTimeToIso } from './otel-time.js';
import { extractResolvedModel } from './resolved-model-extractor.js';
import type { OtelSpanRecord } from './otel-record-parser.js';
import type { UsageConfig } from './config.js';
import type { UsageEvent } from './usage-contract.js';

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toStringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

/** True when a span represents a billable inference call per configuration. */
export function isIncludedSpan(
  span: OtelSpanRecord,
  config: UsageConfig,
): boolean {
  const op = span.attributes[config.attributeKeys.operation];
  return typeof op === 'string' && config.includeOperations.includes(op);
}

/** Normalizes an included span into a canonical UsageEvent. */
export function normalizeSpan(
  span: OtelSpanRecord,
  config: UsageConfig,
  turnIndex: number,
): UsageEvent {
  const a = span.attributes;
  const k = config.attributeKeys;
  const r = span.resource.attributes;
  return {
    sessionId: String(r[config.resourceKeys.sessionId] ?? ''),
    featureId: String(r[config.resourceKeys.featureId] ?? ''),
    turnIndex,
    provider: String(a[k.provider] ?? ''),
    requestedModel: String(a[k.requestModel] ?? ''),
    resolvedModel: extractResolvedModel(a, k),
    operation: String(a[k.operation] ?? ''),
    inputTokens: toNumber(a[k.inputTokens]),
    outputTokens: toNumber(a[k.outputTokens]),
    reasoningOutputTokens: toNumber(a[k.reasoningOutputTokens]),
    cost: toNumber(a[k.cost]),
    nanoAiu: toNumber(a[k.nanoAiu]),
    serviceRequestId: toStringOrNull(a[k.serviceRequestId]),
    startedAt: hrTimeToIso(span.startTime),
    endedAt: hrTimeToIso(span.endTime),
  };
}
