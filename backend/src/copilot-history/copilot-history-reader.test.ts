import { describe, it, expect } from 'vitest';
import { createCopilotHistoryReader } from './copilot-history-reader.js';
import type {
  CopilotHistorySource,
  HistoryCheckpointRow,
  HistorySessionRow,
} from './copilot-history-contract.js';
import { copilotHistoryDefaults } from './config.js';

function fakeSource(overrides: Partial<CopilotHistorySource> = {}): {
  source: CopilotHistorySource;
  calls: { summaries: string[][]; checkpoints: string[][] };
} {
  const calls = { summaries: [] as string[][], checkpoints: [] as string[][] };
  const source: CopilotHistorySource = {
    available: () => true,
    sessionSummaries: (ids) => {
      calls.summaries.push(ids);
      return [];
    },
    checkpoints: (ids) => {
      calls.checkpoints.push(ids);
      return [];
    },
    ...overrides,
  };
  return { source, calls };
}

describe('createCopilotHistoryReader', () => {
  it('returns an empty history per id when no ids are given', () => {
    const { source } = fakeSource();
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.read([])).toEqual([]);
  });

  it('returns empty histories without querying when the source is unavailable', () => {
    const { source, calls } = fakeSource({ available: () => false });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });

    const result = reader.read(['a', 'b']);

    expect(result).toEqual([
      { sessionId: 'a', summary: null, checkpoints: [] },
      { sessionId: 'b', summary: null, checkpoints: [] },
    ]);
    expect(calls.summaries).toHaveLength(0);
    expect(calls.checkpoints).toHaveLength(0);
  });

  it('joins summaries and checkpoints, newest checkpoint first', () => {
    const summaries: HistorySessionRow[] = [
      { id: 's1', summary: 'Did work on s1' },
      { id: 's2', summary: null },
    ];
    const checkpoints: HistoryCheckpointRow[] = [
      {
        session_id: 's1',
        checkpoint_number: 1,
        title: 'First',
        overview: 'First overview',
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        session_id: 's1',
        checkpoint_number: 2,
        title: 'Second',
        overview: 'Second overview',
        created_at: '2024-01-02T00:00:00Z',
      },
    ];
    const { source } = fakeSource({
      sessionSummaries: () => summaries,
      checkpoints: () => checkpoints,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });

    const result = reader.read(['s1', 's2', 's3']);

    expect(result).toEqual([
      {
        sessionId: 's1',
        summary: 'Did work on s1',
        checkpoints: [
          {
            number: 2,
            title: 'Second',
            overview: 'Second overview',
            createdAt: '2024-01-02T00:00:00Z',
          },
          {
            number: 1,
            title: 'First',
            overview: 'First overview',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
      },
      { sessionId: 's2', summary: null, checkpoints: [] },
      { sessionId: 's3', summary: null, checkpoints: [] },
    ]);
  });

  it('coerces null titles/overviews to empty strings', () => {
    const { source } = fakeSource({
      checkpoints: () => [
        {
          session_id: 's1',
          checkpoint_number: 1,
          title: null,
          overview: null,
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });

    expect(reader.read(['s1'])[0].checkpoints[0]).toEqual({
      number: 1,
      title: '',
      overview: '',
      createdAt: '2024-01-01T00:00:00Z',
    });
  });

  it('caps checkpoints and truncates overviews per config', () => {
    const rows: HistoryCheckpointRow[] = Array.from({ length: 5 }, (_, i) => ({
      session_id: 's1',
      checkpoint_number: i + 1,
      title: `t${i + 1}`,
      overview: 'abcdef',
      created_at: `2024-01-0${i + 1}T00:00:00Z`,
    }));
    const { source } = fakeSource({ checkpoints: () => rows });
    const reader = createCopilotHistoryReader({
      source,
      config: {
        ...copilotHistoryDefaults,
        maxCheckpointsPerSession: 2,
        maxOverviewChars: 3,
      },
    });

    const checkpoints = reader.read(['s1'])[0].checkpoints;

    expect(checkpoints.map((c) => c.number)).toEqual([5, 4]);
    expect(checkpoints[0].overview).toBe('abc…');
  });
});
