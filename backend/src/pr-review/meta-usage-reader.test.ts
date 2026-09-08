import { describe, expect, it } from 'vitest';

import { createMetaUsageReader } from './meta-usage-reader.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';
import type { PersistedMetaUsage } from '../meta/meta-usage-contract.js';

function storedUsage(overrides: Partial<StoredUsage>): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt',
    operation: 'chat',
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cost: 0,
    nanoAiu: 0,
    serviceRequestId: null,
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T00:00:01.000Z',
    credits: 0,
    kind: 'dev',
    ...overrides,
  };
}

function warmUsage(
  overrides: Partial<PersistedMetaUsage> = {},
): PersistedMetaUsage {
  return {
    sessionId: 'warm-1',
    featureId: 'f1',
    providerId: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    transport: 'warm-acp',
    providerSessionId: 'provider-1',
    purpose: 'review',
    label: 'PR review',
    inputTokens: 12,
    outputTokens: 5,
    nanoAiu: null,
    credits: null,
    capturedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createMetaUsageReader', () => {
  it('returns null when the session has no usage events', () => {
    const reader = createMetaUsageReader({ usage: { listBySession: () => [] } });
    expect(reader.usageForSession('missing')).toBeNull();
  });

  it('sums tokens, nanoAiu and credits across the session events', () => {
    const events: StoredUsage[] = [
      storedUsage({ inputTokens: 10, outputTokens: 5, nanoAiu: 100, credits: 2 }),
      storedUsage({ inputTokens: 3, outputTokens: 7, nanoAiu: 50, credits: 1, turnIndex: 1 }),
    ];
    const reader = createMetaUsageReader({ usage: { listBySession: () => events } });

    expect(reader.usageForSession('s1')).toEqual({
      sessionId: 's1',
      inputTokens: 13,
      outputTokens: 12,
      nanoAiu: 150,
      credits: 3,
    });
  });

  it('falls back to a persisted warm record when no cold usage rows exist', () => {
    const reader = createMetaUsageReader({
      usage: { listBySession: () => [] },
      warmUsage: { get: (sessionId) => (sessionId === 'warm-1' ? warmUsage() : null), save: () => {}, deleteByFeature: () => {}, deleteBySession: () => {} },
    });

    expect(reader.usageForSession('warm-1')).toEqual({
      sessionId: 'warm-1',
      inputTokens: 12,
      outputTokens: 5,
      nanoAiu: null,
      credits: null,
    });
  });

  it('surfaces unavailable warm usage truthfully instead of inventing zeros', () => {
    const reader = createMetaUsageReader({
      usage: { listBySession: () => [] },
      warmUsage: { get: () => warmUsage({ inputTokens: null, outputTokens: null }), save: () => {}, deleteByFeature: () => {}, deleteBySession: () => {} },
    });

    expect(reader.usageForSession('warm-1')).toEqual({
      sessionId: 'warm-1',
      inputTokens: null,
      outputTokens: null,
      nanoAiu: null,
      credits: null,
    });
  });
});
