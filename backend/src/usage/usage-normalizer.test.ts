import { describe, it, expect } from 'vitest';
import { isIncludedSpan, normalizeSpan } from './usage-normalizer.js';
import { usageDefaults } from './config.js';
import type { OtelSpanRecord } from './otel-record-parser.js';

function span(
  attributes: Record<string, unknown>,
  resourceAttrs: Record<string, unknown> = {},
): OtelSpanRecord {
  return {
    kind: 'span',
    name: 'chat',
    startTime: [10, 0],
    endTime: [12, 0],
    attributes,
    resource: { attributes: resourceAttrs },
  };
}

describe('usage-normalizer', () => {
  it('includes configured operations only', () => {
    expect(isIncludedSpan(span({ 'gen_ai.operation.name': 'chat' }), usageDefaults)).toBe(true);
    expect(
      isIncludedSpan(span({ 'gen_ai.operation.name': 'invoke_agent' }), usageDefaults),
    ).toBe(false);
    expect(isIncludedSpan(span({}), usageDefaults)).toBe(false);
  });

  it('normalizes a fully-populated chat span', () => {
    const record = span(
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'github',
        'gen_ai.request.model': 'auto',
        'gen_ai.response.model': 'gpt-5.4-mini',
        'gen_ai.usage.input_tokens': 15439,
        'gen_ai.usage.output_tokens': 22,
        'gen_ai.usage.reasoning.output_tokens': 15,
        'github.copilot.cost': 0.33,
        'github.copilot.nano_aiu': 1167825000,
        'github.copilot.service_request_id': 'req-1',
      },
      { 'feature.id': 'feat-1', 'session.id': 'sess-1' },
    );

    expect(normalizeSpan(record, usageDefaults, 0)).toEqual({
      sessionId: 'sess-1',
      featureId: 'feat-1',
      turnIndex: 0,
      provider: 'github',
      requestedModel: 'auto',
      resolvedModel: 'gpt-5.4-mini',
      operation: 'chat',
      inputTokens: 15439,
      outputTokens: 22,
      reasoningOutputTokens: 15,
      cost: 0.33,
      nanoAiu: 1167825000,
      serviceRequestId: 'req-1',
      startedAt: '1970-01-01T00:00:10.000Z',
      endedAt: '1970-01-01T00:00:12.000Z',
    });
  });

  it('applies safe defaults for a sparse span', () => {
    const event = normalizeSpan(span({}), usageDefaults, 3);
    expect(event).toMatchObject({
      sessionId: '',
      featureId: '',
      turnIndex: 3,
      provider: '',
      requestedModel: '',
      resolvedModel: 'unknown',
      operation: '',
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      cost: 0,
      nanoAiu: 0,
      serviceRequestId: null,
    });
  });

  it('coerces numeric strings and ignores non-numeric token values', () => {
    const event = normalizeSpan(
      span({ 'gen_ai.usage.input_tokens': '42', 'github.copilot.cost': 'nan' }),
      usageDefaults,
      0,
    );
    expect(event.inputTokens).toBe(42);
    expect(event.cost).toBe(0);
  });
});
