import { describe, it, expect } from 'vitest';
import { createCopilotHistoryReader, isInjectedPrompt } from './copilot-history-reader.js';
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
    userMessages: () => [],
    usageEventTimes: () => [],
    latestActivityTurn: () => null,
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
      { sessionId: 'a', summary: null, firstUserMessage: null, checkpoints: [] },
      { sessionId: 'b', summary: null, firstUserMessage: null, checkpoints: [] },
    ]);
    expect(calls.summaries).toHaveLength(0);
    expect(calls.checkpoints).toHaveLength(0);
  });

  it('joins summaries and checkpoints, newest checkpoint first', () => {
    const summaries: HistorySessionRow[] = [
      {
        id: 's1',
        summary: 'Did work on s1',
        first_user_message: 'please do work on s1',
      },
      { id: 's2', summary: null, first_user_message: null },
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
        firstUserMessage: 'please do work on s1',
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
      { sessionId: 's2', summary: null, firstUserMessage: null, checkpoints: [] },
      { sessionId: 's3', summary: null, firstUserMessage: null, checkpoints: [] },
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

  it('returns no prompts when the source is unavailable', () => {
    const { source, calls } = fakeSource({
      available: () => false,
      userMessages: () => [
        { turn_index: 0, user_message: 'ignored', assistant_response: null, timestamp: '2024-01-01T00:00:00Z' },
      ],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.prompts('s1')).toEqual([]);
    expect(calls.summaries).toHaveLength(0);
  });

  it('maps user messages to timestamped prompts and drops blank ones', () => {
    const { source } = fakeSource({
      userMessages: (sessionId) => {
        expect(sessionId).toBe('s1');
        return [
          { turn_index: 0, user_message: '  First prompt  ', assistant_response: null, timestamp: '2024-01-01T00:00:00Z' },
          { turn_index: 1, user_message: '   ', assistant_response: null, timestamp: '2024-01-01T00:01:00Z' },
          { turn_index: 2, user_message: null, assistant_response: null, timestamp: '2024-01-01T00:02:00Z' },
          { turn_index: 3, user_message: 'Second prompt', assistant_response: null, timestamp: null },
        ];
      },
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.prompts('s1')).toEqual([
      { index: 0, text: 'First prompt', at: '2024-01-01T00:00:00Z', response: null, status: 'unanswered', answeredAt: null, durationMs: null },
      { index: 3, text: 'Second prompt', at: '', response: null, status: 'answering', answeredAt: null, durationMs: null },
    ]);
  });

  it('enriches answered prompts with the windowed answer time and duration', () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Q1', assistant_response: '  A1  ', timestamp: '2024-01-01T00:00:00Z' },
        { turn_index: 1, user_message: 'Q2', assistant_response: null, timestamp: '2024-01-01T00:05:00Z' },
      ],
      // The first two land in turn 0's window; the later one is ignored because
      // turn 1 (the last turn) has no response yet.
      usageEventTimes: () => [
        '2024-01-01T00:00:05Z',
        '2024-01-01T00:00:30Z',
        '2024-01-01T00:06:00Z',
      ],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.prompts('s1')).toEqual([
      {
        index: 0, text: 'Q1', at: '2024-01-01T00:00:00Z', response: 'A1',
        status: 'answered', answeredAt: '2024-01-01T00:00:30.000Z', durationMs: 30000,
      },
      {
        index: 1, text: 'Q2', at: '2024-01-01T00:05:00Z', response: null,
        status: 'answering', answeredAt: null, durationMs: null,
      },
    ]);
  });

  it('computes the answer time of an answered last turn with an open-ended window', () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Only ask', assistant_response: 'Only answer', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:00:45Z', '2024-01-01T00:01:30Z'],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.prompts('s1')).toEqual([
      {
        index: 0, text: 'Only ask', at: '2024-01-01T00:00:00Z', response: 'Only answer',
        status: 'answered', answeredAt: '2024-01-01T00:01:30.000Z', durationMs: 90000,
      },
    ]);
  });

  it('appends a live answering row while the CLI is responding to an unsaved turn', () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Q1', assistant_response: 'A1', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:05:00Z', '2024-01-01T00:05:10Z'],
      latestActivityTurn: () => 1,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => Date.parse('2024-01-01T00:05:20Z'),
    });
    const result = reader.prompts('s1');
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      index: 1, text: '', at: '2024-01-01T00:05:10.000Z', response: null,
      status: 'answering', answeredAt: null, durationMs: null, pending: true,
    });
  });

  it('surfaces the very first prompt as a live answering row before it is saved', () => {
    const { source } = fakeSource({
      usageEventTimes: () => ['2024-01-01T00:00:00Z'],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => Date.parse('2024-01-01T00:00:05Z'),
    });
    expect(reader.prompts('s1')).toEqual([
      {
        index: 0, text: '', at: '2024-01-01T00:00:00.000Z', response: null,
        status: 'answering', answeredAt: null, durationMs: null, pending: true,
      },
    ]);
  });

  it('omits the live row once the in-flight turn is persisted', () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Q1', assistant_response: 'A1', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:00:05Z'],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => Date.parse('2024-01-01T00:00:06Z'),
    });
    expect(reader.prompts('s1')).toHaveLength(1);
  });

  it('omits the live row when assistant activity has gone stale', () => {
    const { source } = fakeSource({
      usageEventTimes: () => ['2024-01-01T00:00:00Z'],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => Date.parse('2024-01-01T00:02:00Z'),
    });
    expect(reader.prompts('s1')).toEqual([]);
  });

  it('omits the live row when no usage-event time is available', () => {
    const { source } = fakeSource({
      usageEventTimes: () => [],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => 1000,
    });
    expect(reader.prompts('s1')).toEqual([]);
  });

  it('marks unanswered and answering turns and tolerates missing times/events', () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Q1', assistant_response: null, timestamp: '2024-01-01T00:00:00Z' },
        { turn_index: 1, user_message: 'Q2', assistant_response: 'A2', timestamp: '2024-01-01T00:05:00Z' },
        { turn_index: 2, user_message: 'Q3', assistant_response: 'A3', timestamp: '' },
        { turn_index: 3, user_message: 'Q4', assistant_response: null, timestamp: '2024-01-01T00:20:00Z' },
      ],
      usageEventTimes: () => [],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.prompts('s1')).toEqual([
      { index: 0, text: 'Q1', at: '2024-01-01T00:00:00Z', response: null, status: 'unanswered', answeredAt: null, durationMs: null },
      { index: 1, text: 'Q2', at: '2024-01-01T00:05:00Z', response: 'A2', status: 'answered', answeredAt: null, durationMs: null },
      { index: 2, text: 'Q3', at: '', response: 'A3', status: 'answered', answeredAt: null, durationMs: null },
      { index: 3, text: 'Q4', at: '2024-01-01T00:20:00Z', response: null, status: 'answering', answeredAt: null, durationMs: null },
    ]);
  });

  it('drops app-injected prompts (bootstrap + metasession scaffolding)', () => {
    const { source } = fakeSource({
      userMessages: () => [
        {
          turn_index: 0,
          user_message: '# Session Bootstrap Context\n\n## Feature\n\n- stuff',
          assistant_response: null,
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          turn_index: 1,
          user_message: 'You maintain a durable, shared knowledge base for a software feature.',
          assistant_response: null,
          timestamp: '2024-01-01T00:01:00Z',
        },
        {
          turn_index: 2,
          user_message: 'An interactive AI coding CLI session just failed with the error output below.',
          assistant_response: null,
          timestamp: '2024-01-01T00:02:00Z',
        },
        {
          turn_index: 3,
          user_message: 'The MCP (Model Context Protocol) server "foo" failed to start.',
          assistant_response: null,
          timestamp: '2024-01-01T00:03:00Z',
        },
        {
          turn_index: 4,
          user_message: 'Please add a dark mode toggle.',
          assistant_response: null,
          timestamp: '2024-01-01T00:04:00Z',
        },
      ],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.prompts('s1')).toEqual([
      { index: 4, text: 'Please add a dark mode toggle.', at: '2024-01-01T00:04:00Z', response: null, status: 'answering', answeredAt: null, durationMs: null },
    ]);
  });
});

describe('isInjectedPrompt', () => {
  it('flags app-injected prompts by their leading sentinel', () => {
    expect(isInjectedPrompt('# Session Bootstrap Context\n\nx')).toBe(true);
    expect(isInjectedPrompt('You maintain a durable, shared knowledge base …')).toBe(true);
    expect(isInjectedPrompt('An interactive AI coding CLI session failed to start')).toBe(true);
    expect(isInjectedPrompt('The MCP (Model Context Protocol) server "x" failed')).toBe(true);
  });

  it('keeps genuine user prompts', () => {
    expect(isInjectedPrompt('Add a dark mode toggle')).toBe(false);
    expect(isInjectedPrompt('Why is the session bootstrap failing?')).toBe(false);
    expect(isInjectedPrompt('')).toBe(false);
  });
});
