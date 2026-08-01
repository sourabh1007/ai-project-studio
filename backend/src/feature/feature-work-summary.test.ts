import { describe, it, expect } from 'vitest';
import { createFeatureWorkSummaryService } from './feature-work-summary.js';
import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type {
  CopilotHistoryReader,
  SessionHistory,
} from '../copilot-history/copilot-history-contract.js';
import type { SessionSummaryStore } from '../session-summary/session-summary-store-port.js';

function session(overrides: Partial<Session>): Session {
  return {
    id: 'sid',
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev',
    prompt: 'do the thing',
    usageFilePath: '/tmp/usage.jsonl',
    createdAt: '2024-01-01T00:00:00Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function repoOf(sessions: Session[]): SessionRepo {
  return {
    save: () => undefined,
    get: () => null,
    listByFeature: () => sessions,
    listAll: () => sessions,
    delete: () => undefined,
    deleteByFeature: () => undefined,
    rename: () => undefined,
  };
}

function readerOf(histories: SessionHistory[]): CopilotHistoryReader {
  return { read: () => histories };
}

function storeOf(
  generated: Record<string, string> = {},
): SessionSummaryStore {
  return {
    save: () => undefined,
    delete: () => undefined,
    load: (sessionId) =>
      sessionId in generated
        ? {
            sessionId,
            content: generated[sessionId],
            createdAt: '2024-05-01T00:00:00Z',
          }
        : null,
  };
}

describe('createFeatureWorkSummaryService', () => {
  it('joins dev sessions to CLI history, newest first, excluding meta sessions', () => {
    const sessions = [
      session({ id: 'older', createdAt: '2024-01-01T00:00:00Z' }),
      session({ id: 'newer', createdAt: '2024-02-01T00:00:00Z' }),
      session({ id: 'meta', kind: 'meta', createdAt: '2024-03-01T00:00:00Z' }),
    ];
    const histories: SessionHistory[] = [
      {
        sessionId: 'newer',
        summary: 'newer summary',
        checkpoints: [
          {
            number: 1,
            title: 'CP',
            overview: 'ov',
            createdAt: '2024-02-01T01:00:00Z',
          },
        ],
      },
    ];
    const service = createFeatureWorkSummaryService({
      sessions: repoOf(sessions),
      reader: readerOf(histories),
      summaries: storeOf(),
    });

    const result = service.getByFeature('f1');

    expect(result.featureId).toBe('f1');
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['newer', 'older']);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'newer',
      prompt: 'do the thing',
      status: 'completed',
      summary: 'newer summary',
    });
    expect(result.sessions[0].checkpoints).toHaveLength(1);
    expect(result.sessions[1]).toMatchObject({
      sessionId: 'older',
      summary: null,
    });
    expect(result.sessions[1].checkpoints).toEqual([]);
  });

  it('prefers a generated session summary over the CLI summary', () => {
    const sessions = [session({ id: 's1', createdAt: '2024-01-01T00:00:00Z' })];
    const histories: SessionHistory[] = [
      { sessionId: 's1', summary: 'cli summary', checkpoints: [] },
    ];
    const service = createFeatureWorkSummaryService({
      sessions: repoOf(sessions),
      reader: readerOf(histories),
      summaries: storeOf({ s1: 'generated summary' }),
    });

    expect(service.getByFeature('f1').sessions[0].summary).toBe(
      'generated summary',
    );
  });

  it('returns an empty session list for a feature with no dev sessions', () => {
    const service = createFeatureWorkSummaryService({
      sessions: repoOf([session({ kind: 'meta' })]),
      reader: readerOf([]),
      summaries: storeOf(),
    });
    expect(service.getByFeature('f1')).toEqual({ featureId: 'f1', sessions: [] });
  });
});
