import { describe, it, expect, vi } from 'vitest';
import { createSessionSummaryAutoTrigger } from './session-summary-auto.js';
import type {
  SessionSummarizer,
  SessionSummary,
} from './session-summary-contract.js';
import type { Session } from '../session/session-contract.js';
import type { SessionKind } from '../provider/provider-contract.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    provider: 'agency',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev' as SessionKind,
    prompt: 'do work',
    usageFilePath: '/tmp/usage.jsonl',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

function summary(): SessionSummary {
  return { sessionId: 's1', content: 'done', createdAt: '2026-01-01T00:00:00.000Z' };
}

function deps(overrides: Partial<SessionSummarizer> = {}) {
  const summarizer: SessionSummarizer = {
    summarize: vi.fn().mockResolvedValue(summary()),
    get: vi.fn().mockReturnValue(null),
    ...overrides,
  };
  const logger = { error: vi.fn() };
  return { summarizer, logger };
}

describe('createSessionSummaryAutoTrigger', () => {
  it('summarizes a dev session with no existing summary', () => {
    const { summarizer, logger } = deps();
    const trigger = createSessionSummaryAutoTrigger({ summarizer, logger });

    trigger.onSessionEnded(session());

    expect(summarizer.get).toHaveBeenCalledWith('s1');
    expect(summarizer.summarize).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('skips non-dev sessions to avoid meta recursion', () => {
    const { summarizer, logger } = deps();
    const trigger = createSessionSummaryAutoTrigger({ summarizer, logger });

    trigger.onSessionEnded(session({ kind: 'meta' as SessionKind }));

    expect(summarizer.get).not.toHaveBeenCalled();
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('skips sessions that already have a summary', () => {
    const { summarizer, logger } = deps({
      get: vi.fn().mockReturnValue(summary()),
    });
    const trigger = createSessionSummaryAutoTrigger({ summarizer, logger });

    trigger.onSessionEnded(session());

    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('logs when summarization rejects', async () => {
    const error = new Error('boom');
    const { summarizer, logger } = deps({
      summarize: vi.fn().mockRejectedValue(error),
    });
    const trigger = createSessionSummaryAutoTrigger({ summarizer, logger });

    trigger.onSessionEnded(session());
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith('Auto session summary failed', error);
  });
});
