import { describe, expect, it } from 'vitest';

import { createMetaUsageReader } from './meta-usage-reader.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

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
});
