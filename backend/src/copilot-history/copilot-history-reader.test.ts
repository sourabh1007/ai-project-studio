import { describe, it, expect } from 'vitest';
import { createCopilotHistoryReader, isInjectedPrompt, extractUserRequest, toVisiblePrompt } from './copilot-history-reader.js';
import {
  PromptHistoryUnavailableError,
  type CopilotHistorySource,
  type HistoryCheckpointRow,
  type HistorySessionRow,
  type HistoryUserMessageRow,
  type LivePromptTurn,
} from './copilot-history-contract.js';
import { copilotHistoryDefaults } from './config.js';
import { parseLatestLivePrompt } from './copilot-live-prompt-parser.js';

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
  it('requires a bounded native port and a valid bounded limit', async () => {
    const { source } = fakeSource();
    const reader = createCopilotHistoryReader({ source, config: copilotHistoryDefaults });
    for (const limit of [0, 101, 1.5, 1]) await expect(reader.recentPrompts!('s', limit)).rejects.toThrow('Bounded');
  });

  it('merges bounded saved evidence with matching live completion without changing turn identity', async () => {
    const { source } = fakeSource({
      recentUserMessages: () => [
        { turn_index: 0, user_message: '# Session Bootstrap Context', assistant_response: null, timestamp: null },
        { turn_index: 1, user_message: 'Fix lock', assistant_response: 'Saved reply', timestamp: 'at' },
      ],
    });
    let live: import('./copilot-history-contract.js').LivePromptTurn | null = {
      text: 'Fix lock', response: 'Completed fix', at: 'at', completedAt: 'end',
    };
    const reader = createCopilotHistoryReader({ source, config: copilotHistoryDefaults, livePrompts: { latest: () => live } });
    expect(await reader.recentPrompts!('s', 4)).toEqual([expect.objectContaining({ index: 1, text: 'Fix lock', status: 'answered', response: 'Completed fix', answeredAt: 'end' })]);
    live = { text: 'Fix lock', at: 'at', response: null };
    expect((await reader.recentPrompts!('s', 4))[0].status).toBe('answered');
    live = { text: 'Add regression test', at: 'later', response: null };
    expect(await reader.recentPrompts!('s', 1)).toEqual([expect.objectContaining({ index: 2, status: 'answering', answeredAt: null, response: null })]);
    live = { text: '# Session Bootstrap Context', at: '', response: null };
    expect(await reader.recentPrompts!('s', 4)).toHaveLength(1);
    live = null;
    expect(await reader.recentPrompts!('s', 4)).toHaveLength(1);
  });

  it('handles empty native stores, nullable saved text/times, and a live-only first turn', async () => {
    const { source } = fakeSource({ recentUserMessages: () => [] });
    const noLive = createCopilotHistoryReader({ source, config: copilotHistoryDefaults });
    expect(await noLive.recentPrompts!('s', 4)).toEqual([]);
    const liveOnly = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, livePrompts: { latest: () => ({ text: 'First request', at: '', response: null }) },
    });
    expect(await liveOnly.recentPrompts!('s', 4)).toEqual([expect.objectContaining({ index: 0, text: 'First request', status: 'answering' })]);
    const nullable = fakeSource({
      recentUserMessages: () => [
        { turn_index: 0, user_message: null, assistant_response: null, timestamp: null },
        { turn_index: 1, user_message: 'Ask', assistant_response: null, timestamp: null },
      ],
    });
    expect(await createCopilotHistoryReader({ source: nullable.source, config: copilotHistoryDefaults }).recentPrompts!('s', 4))
      .toEqual([expect.objectContaining({ at: '', status: 'unanswered', response: null })]);
  });
  it.each([false, true])('uses recorded completion with recent usage and delayed persistence (saved=%s)', async (saved) => {
    const { source } = fakeSource({
      userMessages: () => saved ? [
        { turn_index: 0, user_message: 'ask', assistant_response: null, timestamp: '2024-01-01T00:00:00Z' },
      ] : [],
      usageEventTimes: () => ['2024-01-01T00:00:09Z'],
    });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, now: () => Date.parse('2024-01-01T00:00:10Z'),
      livePrompts: { latest: () => parseLatestLivePrompt([
        JSON.stringify({ type: 'user.message', data: { content: 'ask', messageId: 'm1', turnId: '0' }, timestamp: '2024-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'assistant.message', data: { originatingMessageId: 'm1', content: 'Done.' } }),
        JSON.stringify({ type: 'assistant.turn_end', data: { turnId: '0' }, timestamp: '2024-01-01T00:00:05Z' }),
      ].join('\n'), toVisiblePrompt) },
    });
    expect((await reader.prompts('s1'))).toEqual([{
      index: 0, text: 'ask', at: '2024-01-01T00:00:00Z', response: 'Done.',
      status: 'answered', answeredAt: '2024-01-01T00:00:05Z', durationMs: 5000,
      ...(!saved ? { pending: true } : {}),
    }]);
  });

  it.each([false, true])('keeps a partial live response generating until completion (saved=%s)', async (saved) => {
    const { source } = fakeSource({
      userMessages: () => saved ? [
        { turn_index: 0, user_message: 'ask', assistant_response: null, timestamp: '2024-01-01T00:00:00Z' },
      ] : [],
      usageEventTimes: () => ['2024-01-01T00:00:09Z'],
    });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, now: () => Date.parse('2024-01-01T00:00:10Z'),
      livePrompts: { latest: () => ({ text: 'ask', at: '2024-01-01T00:00:00Z', response: 'Checking…' }) },
    });
    expect((await reader.prompts('s1'))[0]).toMatchObject({ response: 'Checking…', status: 'answering', answeredAt: null });
  });

  it.each([false, true])('keeps completion without a recorded reply distinct from generating (saved=%s)', async (saved) => {
    const { source } = fakeSource({
      userMessages: () => saved ? [
        { turn_index: 0, user_message: 'ask', assistant_response: null, timestamp: '' },
      ] : [],
      usageEventTimes: () => ['2024-01-01T00:00:09Z'],
    });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, now: () => Date.parse('2024-01-01T00:00:10Z'),
      livePrompts: { latest: () => ({ text: 'ask', at: '', response: null, completedAt: null }) },
    });
    expect((await reader.prompts('s1'))[0]).toMatchObject({ response: null, status: 'unanswered', answeredAt: null, durationMs: null });
  });

  it('does not discard a repeated prompt entered in a new turn', async () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'ask', assistant_response: 'Old answer', timestamp: '2024-01-01T00:00:00Z' },
      ],
    });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({
        text: 'ask', at: '2024-01-01T00:01:00Z', response: 'New answer',
        completedAt: '2024-01-01T00:01:05Z',
      }) },
    });
    expect((await reader.prompts('s1'))).toHaveLength(2);
    expect((await reader.prompts('s1'))[1]).toMatchObject({ response: 'New answer', status: 'answered' });
  });

  it.each([null, 'Finished reply'])('reconciles an idle saved prompt without inventing a response (%s)', async (response) => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'ask', assistant_response: null, timestamp: '2024-01-01T00:00:00Z' },
      ],
    });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, now: () => Date.parse('2024-01-01T01:00:00Z'),
      livePrompts: { latest: () => ({ text: 'ask', at: '2024-01-01T00:00:00.000Z', response }) },
    });
    expect((await reader.prompts('s1'))).toHaveLength(1);
    expect((await reader.prompts('s1'))[0]).toMatchObject({
      response, status: response ? 'answered' : 'unanswered', answeredAt: null,
    });
  });

  it('uses the recorded completion time over stored text and later billing timestamps', async () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'ask', assistant_response: 'Done.', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:00:09Z'],
    });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({
        text: 'ask', at: '2024-01-01T00:00:00Z', response: null, completedAt: '2024-01-01T00:00:05Z',
      }) },
    });
    expect((await reader.prompts('s1'))[0]).toMatchObject({
      response: 'Done.', status: 'answered', answeredAt: '2024-01-01T00:00:05Z', durationMs: 5000,
    });
  });

  it('returns an empty history per id when no ids are given', async () => {
    const { source } = fakeSource();
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
    });
    expect(reader.read([])).toEqual([]);
  });

  it('returns empty histories without querying when the source is unavailable', async () => {
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

  it('joins summaries and checkpoints, newest checkpoint first', async () => {
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

  it('coerces null titles/overviews to empty strings', async () => {
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

  it('caps checkpoints and truncates overviews per config', async () => {
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

  it('returns no prompts when the source is unavailable', async () => {
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
    expect((await reader.prompts('s1'))).toEqual([]);
    expect(calls.summaries).toHaveLength(0);
  });

  it('maps user messages to timestamped prompts and drops blank ones', async () => {
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
    expect((await reader.prompts('s1'))).toEqual([
      { index: 0, text: 'First prompt', at: '2024-01-01T00:00:00Z', response: null, status: 'unanswered', answeredAt: null, durationMs: null },
      { index: 3, text: 'Second prompt', at: '', response: null, status: 'unanswered', answeredAt: null, durationMs: null },
    ]);
  });

  it('enriches answered prompts with the windowed answer time and duration', async () => {
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
    expect((await reader.prompts('s1'))).toEqual([
      {
        index: 0, text: 'Q1', at: '2024-01-01T00:00:00Z', response: 'A1',
        status: 'answered', answeredAt: '2024-01-01T00:00:30.000Z', durationMs: 30000,
      },
      {
        index: 1, text: 'Q2', at: '2024-01-01T00:05:00Z', response: null,
        status: 'unanswered', answeredAt: null, durationMs: null,
      },
    ]);
  });

  it('computes the answer time of an answered last turn with an open-ended window', async () => {
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
    expect((await reader.prompts('s1'))).toEqual([
      {
        index: 0, text: 'Only ask', at: '2024-01-01T00:00:00Z', response: 'Only answer',
        status: 'answered', answeredAt: '2024-01-01T00:01:30.000Z', durationMs: 90000,
      },
    ]);
  });

  it('appends a live answering row while the CLI is responding to an unsaved turn', async () => {
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
    const result = (await reader.prompts('s1'));
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      index: 1, text: '', at: '2024-01-01T00:05:10.000Z', response: null,
      status: 'answering', answeredAt: null, durationMs: null, pending: true,
    });
  });

  it('surfaces the very first prompt as a live answering row before it is saved', async () => {
    const { source } = fakeSource({
      usageEventTimes: () => ['2024-01-01T00:00:00Z'],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => Date.parse('2024-01-01T00:00:05Z'),
    });
    expect((await reader.prompts('s1'))).toEqual([
      {
        index: 0, text: '', at: '2024-01-01T00:00:00.000Z', response: null,
        status: 'answering', answeredAt: null, durationMs: null, pending: true,
      },
    ]);
  });

  it('omits the live row once the in-flight turn is persisted', async () => {
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
    expect((await reader.prompts('s1'))).toHaveLength(1);
  });

  it('omits the live row when assistant activity has gone stale', async () => {
    const { source } = fakeSource({
      usageEventTimes: () => ['2024-01-01T00:00:00Z'],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => Date.parse('2024-01-01T00:02:00Z'),
    });
    expect((await reader.prompts('s1'))).toEqual([]);
  });

  it('omits the live row when no usage-event time is available', async () => {
    const { source } = fakeSource({
      usageEventTimes: () => [],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      now: () => 1000,
    });
    expect((await reader.prompts('s1'))).toEqual([]);
  });

  it('shows the live prompt and streamed reply for an unsaved in-flight turn', async () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Q1', assistant_response: 'A1', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:05:10Z'],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: '  Latest prompt  ', at: '2024-01-01T00:05:00Z', response: '  reply so far  ' }) },
      now: () => Date.parse('2024-01-01T00:05:20Z'),
    });
    const result = (await reader.prompts('s1'));
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      index: 1, text: 'Latest prompt', at: '2024-01-01T00:05:00Z', response: 'reply so far',
      status: 'answering', answeredAt: null, durationMs: null, pending: true,
    });
  });

  it('keeps an idle live prompt visible without claiming an unrecorded answer', async () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Q1', assistant_response: 'A1', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:00:10Z'],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: 'Latest prompt', at: '2024-01-01T00:00:05Z', response: null }) },
      now: () => Date.parse('2024-01-01T01:00:00Z'),
    });
    expect((await reader.prompts('s1'))[1]).toEqual({
      index: 1, text: 'Latest prompt', at: '2024-01-01T00:00:05Z', response: null,
      status: 'unanswered', answeredAt: null, durationMs: null, pending: true,
    });
  });

  it('surfaces the very first live prompt before any turn is saved, with no events', async () => {
    const { source } = fakeSource({
      usageEventTimes: () => [],
      latestActivityTurn: () => null,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: 'First ever', at: '2024-01-01T00:00:00Z', response: '' }) },
      now: () => 1000,
    });
    expect((await reader.prompts('s1'))).toEqual([
      {
        index: 0, text: 'First ever', at: '2024-01-01T00:00:00Z', response: null,
        status: 'unanswered', answeredAt: null, durationMs: null, pending: true,
      },
    ]);
  });

  it('treats a whitespace-only live reply as no response yet', async () => {
    const { source } = fakeSource({ userMessages: () => [] });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: 'Ask', at: 't', response: '   ' }) },
      now: () => 1000,
    });
    expect((await reader.prompts('s1'))[0].response).toBeNull();
  });

  it('drops the live row once the in-flight prompt matches the newest saved turn', async () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: 'Saved prompt', assistant_response: 'A1', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:00:05Z'],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: 'Saved prompt', at: '2024-01-01T00:00:00Z', response: 'A1' }) },
      now: () => Date.parse('2024-01-01T00:00:06Z'),
    });
    expect((await reader.prompts('s1'))).toHaveLength(1);
  });

  it('ignores a blank or injected live prompt', async () => {
    const blank = fakeSource({ userMessages: () => [] });
    expect(
      await createCopilotHistoryReader({
        source: blank.source,
        config: copilotHistoryDefaults,
        livePrompts: { latest: () => ({ text: '   ', at: 't', response: null }) },
        now: () => 1000,
      }).prompts('s1'),
    ).toEqual([]);

    const injected = fakeSource({ userMessages: () => [] });
    expect(
      await createCopilotHistoryReader({
        source: injected.source,
        config: copilotHistoryDefaults,
        livePrompts: { latest: () => ({ text: '# Session Bootstrap Context\n\nx', at: 't', response: null }) },
        now: () => 1000,
      }).prompts('s1'),
    ).toEqual([]);
  });

  it('falls back to the activity indicator when the live source returns null', async () => {
    const { source } = fakeSource({
      usageEventTimes: () => ['2024-01-01T00:00:00Z'],
      latestActivityTurn: () => 0,
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => null },
      now: () => Date.parse('2024-01-01T00:00:05Z'),
    });
    expect((await reader.prompts('s1'))).toEqual([
      {
        index: 0, text: '', at: '2024-01-01T00:00:00.000Z', response: null,
        status: 'answering', answeredAt: null, durationMs: null, pending: true,
      },
    ]);
  });

  it('marks unanswered and answering turns and tolerates missing times/events', async () => {
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
    expect((await reader.prompts('s1'))).toEqual([
      { index: 0, text: 'Q1', at: '2024-01-01T00:00:00Z', response: null, status: 'unanswered', answeredAt: null, durationMs: null },
      { index: 1, text: 'Q2', at: '2024-01-01T00:05:00Z', response: 'A2', status: 'answered', answeredAt: null, durationMs: null },
      { index: 2, text: 'Q3', at: '', response: 'A3', status: 'answered', answeredAt: null, durationMs: null },
      { index: 3, text: 'Q4', at: '2024-01-01T00:20:00Z', response: null, status: 'unanswered', answeredAt: null, durationMs: null },
    ]);
  });

  it('drops app-injected prompts (bootstrap + metasession scaffolding)', async () => {
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
    expect((await reader.prompts('s1'))).toEqual([
      { index: 4, text: 'Please add a dark mode toggle.', at: '2024-01-01T00:04:00Z', response: null, status: 'unanswered', answeredAt: null, durationMs: null },
    ]);
  });
});

describe('isInjectedPrompt', () => {
  it('flags app-injected prompts by their leading sentinel', async () => {
    expect(isInjectedPrompt('# Session Bootstrap Context\n\nx')).toBe(true);
    expect(isInjectedPrompt('You maintain a durable, shared knowledge base …')).toBe(true);
    expect(isInjectedPrompt('An interactive AI coding CLI session failed to start')).toBe(true);
    expect(isInjectedPrompt('The MCP (Model Context Protocol) server "x" failed')).toBe(true);
  });

  it('keeps genuine user prompts', async () => {
    expect(isInjectedPrompt('Add a dark mode toggle')).toBe(false);
    expect(isInjectedPrompt('Why is the session bootstrap failing?')).toBe(false);
    expect(isInjectedPrompt('')).toBe(false);
  });
});

describe('extractUserRequest', () => {
  it('returns the request embedded after the launch marker', async () => {
    const launch =
      '# Session Bootstrap Context\n\n## Feature\n\nName: X\n\n## User Request\n\nBuild the thing';
    expect(extractUserRequest(launch)).toBe('Build the thing');
  });

  it('returns null when there is no embedded request', async () => {
    expect(extractUserRequest('# Session Bootstrap Context\n\njust context')).toBeNull();
    expect(
      extractUserRequest('# Session Bootstrap Context\n\n## User Request\n\n   '),
    ).toBeNull();
  });
});

describe('toVisiblePrompt', () => {
  it('passes genuine prompts through trimmed', async () => {
    expect(toVisiblePrompt('  Add a toggle  ')).toBe('Add a toggle');
  });

  it('hides blank and pure-injected prompts', async () => {
    expect(toVisiblePrompt('   ')).toBeNull();
    expect(toVisiblePrompt('You maintain a durable, shared knowledge base …')).toBeNull();
  });

  it('unwraps a launch prompt to its embedded request', async () => {
    expect(
      toVisiblePrompt('# Session Bootstrap Context\n\nctx\n\n## User Request\n\nFix the bug'),
    ).toBe('Fix the bug');
  });

  it('hides a launch wrapper whose embedded request is itself an app template', async () => {
    expect(
      toVisiblePrompt(
        '# Session Bootstrap Context\n\nctx\n\n## User Request\n\nYou maintain a durable, shared knowledge base …',
      ),
    ).toBeNull();
  });
});

describe('createCopilotHistoryReader launch-prompt unwrapping', () => {
  const launch =
    '# Session Bootstrap Context\n\n## Feature\n\nName: X\n\n## User Request\n\nLaunch request';

  it('surfaces the embedded request of a launched session first turn from the store', async () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: launch, assistant_response: 'A1', timestamp: '2024-01-01T00:00:00Z' },
        { turn_index: 1, user_message: 'Typed follow-up', assistant_response: 'A2', timestamp: '2024-01-01T00:05:00Z' },
      ],
    });
    const reader = createCopilotHistoryReader({ source, config: copilotHistoryDefaults });
    const result = (await reader.prompts('s1'));
    expect(result.map((p) => p.text)).toEqual(['Launch request', 'Typed follow-up']);
  });

  it('surfaces the embedded request of a launch prompt that is still in-flight (live)', async () => {
    const { source } = fakeSource({ userMessages: () => [] });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: launch, at: '2024-01-01T00:00:00Z', response: null }) },
      now: () => 1000,
    });
    expect((await reader.prompts('s1'))).toEqual([
      {
        index: 0, text: 'Launch request', at: '2024-01-01T00:00:00Z', response: null,
        status: 'unanswered', answeredAt: null, durationMs: null, pending: true,
      },
    ]);
  });

  it('drops the live launch row once the store persists the same unwrapped turn', async () => {
    const { source } = fakeSource({
      userMessages: () => [
        { turn_index: 0, user_message: launch, assistant_response: 'A1', timestamp: '2024-01-01T00:00:00Z' },
      ],
      usageEventTimes: () => ['2024-01-01T00:00:05Z'],
    });
    const reader = createCopilotHistoryReader({
      source,
      config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: launch, at: '2024-01-01T00:00:00Z', response: 'A1' }) },
      now: () => Date.parse('2024-01-01T00:00:06Z'),
    });
    expect((await reader.prompts('s1'))).toHaveLength(1);
  });
});

describe('createCopilotHistoryReader freshness and read reliability', () => {
  const NOW = Date.parse('2024-01-01T01:00:00.000Z');
  const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();
  const row = (turn_index: number, user_message: string, assistant_response: string | null, timestamp: string) =>
    ({ turn_index, user_message, assistant_response, timestamp });
  const build = (
    overrides: Partial<CopilotHistorySource>,
    deps: Partial<Parameters<typeof createCopilotHistoryReader>[0]> = {},
  ) => createCopilotHistoryReader({
    source: fakeSource(overrides).source,
    config: { ...copilotHistoryDefaults, livePromptTimeoutMs: 20 },
    now: () => NOW,
    ...deps,
  });

  it('shows an unsaved turn and its streaming reply while the store is one turn behind', async () => {
    const stored = [row(0, 'Q1', 'A1', secondsAgo(300))];
    const live = { text: 'Q2', at: secondsAgo(20), response: 'partial', lastActivityAt: secondsAgo(2) };
    const reader = build({ userMessages: () => stored, usageEventTimes: () => [secondsAgo(2)] }, {
      livePrompts: { latest: async () => live },
    });
    const prompts = await reader.prompts('s1');
    expect(prompts.map((p) => [p.index, p.text, p.response, p.status, p.pending])).toEqual([
      [0, 'Q1', 'A1', 'answered', undefined],
      [1, 'Q2', 'partial', 'answering', true],
    ]);
    stored.push(row(1, 'Q2', 'partial final', live.at));
    const saved = await reader.prompts('s1');
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ index: 1, response: 'partial final', status: 'answered' });
    expect(saved[1].pending).toBeUndefined();
  });

  it('does not leave the previous saved turn spinning when a newer live turn exists', async () => {
    const reader = build(
      { userMessages: () => [row(0, 'Q1', null, secondsAgo(30))], usageEventTimes: () => [secondsAgo(1)] },
      { livePrompts: { latest: () => ({ text: 'Q2', at: secondsAgo(5), response: null }) } },
    );
    const prompts = await reader.prompts('s1');
    expect(prompts.map((p) => p.status)).toEqual(['unanswered', 'answering']);
  });

  it.each([
    ['an old unanswered last turn', secondsAgo(3600), [] as string[], 'unanswered'],
    ['a prompt entered moments ago without events yet', secondsAgo(3), [] as string[], 'answering'],
    ['an old prompt with fresh billing activity', secondsAgo(3600), [secondsAgo(4)], 'answering'],
    ['a prompt dated far in the future (clock skew)', new Date(NOW + 3_600_000).toISOString(), [] as string[], 'unanswered'],
  ])('derives the last stored turn status from %s', async (_name, at, events, status) => {
    const reader = build({ userMessages: () => [row(0, 'Q', null, at)], usageEventTimes: () => events });
    expect((await reader.prompts('s1'))[0].status).toBe(status);
  });

  it('keeps a long tool-running live turn answering from log activity despite stale billing events', async () => {
    const make = (lastActivityAt: string) => build(
      { userMessages: () => [], usageEventTimes: () => [secondsAgo(600)] },
      { livePrompts: { latest: () => ({ text: 'Run tests', at: secondsAgo(900), response: null, lastActivityAt }) } },
    );
    expect((await make(secondsAgo(3)).prompts('s1'))[0].status).toBe('answering');
    expect((await make(secondsAgo(500)).prompts('s1'))[0].status).toBe('unanswered');
  });

  it.each([
    ['stored text is longer than a tail-truncated live reply', undefined, 'stored full answer', 'live', 'stored full answer'],
    ['live reply is newer and longer', undefined, 'old', 'old plus streaming', 'old plus streaming'],
    ['the live turn completed, so it is authoritative', secondsAgo(1), 'stored full answer', 'final', 'final'],
  ])('chooses the reply when %s', async (_name, completedAt, stored, liveText, expected) => {
    const reader = build(
      { userMessages: () => [row(0, 'Q', stored, secondsAgo(10))] },
      { livePrompts: { latest: () => ({
        text: 'Q', at: secondsAgo(10), response: liveText, ...(completedAt ? { completedAt } : {}),
      }) } },
    );
    expect((await reader.prompts('s1'))[0].response).toBe(expected);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('EBUSY: resource busy')), 'EBUSY'],
    ['throws synchronously', () => { throw new Error('EPERM'); }, 'EPERM'],
    ['hangs', () => new Promise<never>(() => undefined), 'exceeded 20ms'],
  ])('reports unavailable, never older store-only history, when the live read %s', async (_name, latest, reason) => {
    const failures: [string, unknown][] = [];
    const reader = build(
      { userMessages: () => [row(0, 'Q1', 'A1', secondsAgo(300))] },
      { livePrompts: { latest }, onLiveReadFailure: (id, error) => failures.push([id, error]) },
    );
    await expect(reader.prompts('s1')).rejects.toBeInstanceOf(PromptHistoryUnavailableError);
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe('s1');
    expect(String(failures[0][1])).toContain(reason);
  });

  it('aborts the underlying live read on timeout but not on success', async () => {
    const signals: AbortSignal[] = [];
    const hung = build({ userMessages: () => [] }, {
      livePrompts: { latest: (_id, signal) => { signals.push(signal!); return new Promise<never>(() => undefined); } },
    });
    await expect(hung.prompts('s1')).rejects.toBeInstanceOf(PromptHistoryUnavailableError);
    expect(signals[0].aborted).toBe(true);
    const ok = build({ userMessages: () => [] }, {
      livePrompts: { latest: (_id, signal) => { signals.push(signal!); return null; } },
    });
    await ok.prompts('s1');
    expect(signals[1].aborted).toBe(false);
  });

  it('rejects as unavailable when the live read fails and no failure hook is wired', async () => {
    const reader = build({ userMessages: () => [row(0, 'Q1', 'A1', secondsAgo(300))] }, {
      livePrompts: { latest: () => Promise.reject(new Error('EBUSY')) },
    });
    await expect(reader.prompts('s1')).rejects.toThrow('Live prompt history could not be read');
  });

  it('never replaces a known live turn with older store-only history after a transient live failure', async () => {
    const stored = [row(0, 'Q1', 'A1', secondsAgo(300))];
    const live = { text: 'Q2', at: secondsAgo(20), response: 'streamed answer', lastActivityAt: secondsAgo(2) };
    let mode: 'ok' | 'fail' | 'absent' = 'ok';
    const failures: unknown[] = [];
    const reader = build({ userMessages: () => stored, usageEventTimes: () => [secondsAgo(2)] }, {
      livePrompts: { latest: () => {
        if (mode === 'fail') return Promise.reject(new Error('timed out'));
        return mode === 'ok' ? live : null;
      } },
      onLiveReadFailure: (_id, error) => failures.push(error),
    });
    expect((await reader.prompts('s1')).map((p) => p.response)).toEqual(['A1', 'streamed answer']);
    mode = 'fail';
    await expect(reader.prompts('s1')).rejects.toBeInstanceOf(PromptHistoryUnavailableError);
    expect(failures).toHaveLength(1);
    mode = 'absent';
    expect((await reader.prompts('s1')).map((p) => p.text)).toEqual(['Q1']);
    mode = 'ok';
    expect((await reader.prompts('s1')).map((p) => p.response)).toEqual(['A1', 'streamed answer']);
  });

  it('propagates an unreadable store instead of returning an empty history', async () => {
    const reader = build({
      userMessages: () => { throw new PromptHistoryUnavailableError('locked'); },
    });
    await expect(reader.prompts('s1')).rejects.toBeInstanceOf(PromptHistoryUnavailableError);
  });
});

describe('queued prompt history', () => {
  const at = (second: number) => `2024-01-01T00:00:${String(second).padStart(2, '0')}Z`;
  const event = (type: string, data: unknown, second: number) => JSON.stringify({ type, data, timestamp: at(second) });

  it('keeps three rapid prompts with their own replies before, during and after store persistence', async () => {
    const stored: HistoryUserMessageRow[] = [
      { turn_index: 7, user_message: '# Session Bootstrap Context', assistant_response: null, timestamp: at(0) },
    ];
    const { source } = fakeSource({ userMessages: () => stored, recentUserMessages: () => stored });
    const events = [
      event('user.message', { content: 'First request', messageId: 'a' }, 0),
      event('assistant.turn_start', { turnId: 'ta' }, 1),
      event('user.message', { content: 'Second request', messageId: 'b' }, 2),
      event('user.message', { content: 'Third request', messageId: 'c' }, 3),
      event('assistant.message', { originatingMessageId: 'a', content: 'Only A answer' }, 5),
      event('assistant.turn_end', { turnId: 'ta' }, 6),
    ];
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, now: () => Date.parse(at(20)),
      livePrompts: { latest: () => parseLatestLivePrompt(events.join('\n'), toVisiblePrompt) },
    });
    let rows = await reader.prompts('s');
    expect(rows.map((row) => [row.index, row.text, row.response, row.queued ?? false])).toEqual([
      [8, 'First request', 'Only A answer', false],
      [9, 'Second request', null, true],
      [10, 'Third request', null, true],
    ]);
    expect(rows[0]).toMatchObject({ status: 'answered', durationMs: 6000, answeredAt: at(6) });
    expect((await reader.recentPrompts!('s', 2)).map((row) => row.text)).toEqual(['Second request', 'Third request']);
    events.push(
      event('assistant.turn_start', { turnId: 'tb' }, 7),
      event('assistant.message', { originatingMessageId: 'b', content: 'Only B answer' }, 8),
      event('assistant.turn_end', { turnId: 'tb' }, 9),
      event('assistant.turn_start', { turnId: 'tc' }, 10),
      event('assistant.message', { originatingMessageId: 'c', content: 'Only C answer' }, 11),
      event('assistant.turn_end', { turnId: 'tc' }, 12),
    );
    stored.push({ turn_index: 8, user_message: 'First request', assistant_response: 'Only A answer', timestamp: at(0) });
    rows = await reader.prompts('s');
    expect(rows.map((row) => row.response)).toEqual(['Only A answer', 'Only B answer', 'Only C answer']);
    stored.push(
      { turn_index: 9, user_message: 'Second request', assistant_response: 'Only B answer', timestamp: at(2) },
      { turn_index: 10, user_message: 'Third request', assistant_response: 'Only C answer', timestamp: at(3) },
    );
    rows = await reader.prompts('s');
    expect(rows.map((row) => row.index)).toEqual([8, 9, 10]);
    expect(rows.every((row) => row.status === 'answered' && !row.pending && !row.queued)).toBe(true);
    expect((await reader.recentPrompts!('s', 3)).map((row) => row.response)).toEqual(['Only A answer', 'Only B answer', 'Only C answer']);
  });

  it('does not collapse repeated prompt text, and keeps longer stored replies until a final live reply arrives', async () => {
    const stored: HistoryUserMessageRow[] = [
      { turn_index: 0, user_message: 'Repeat', assistant_response: 'Stored complete text', timestamp: '2024-01-01T00:00:00.000Z' },
      { turn_index: 1, user_message: 'Repeat', assistant_response: null, timestamp: at(2) },
    ];
    const first: LivePromptTurn = { text: 'Repeat', response: 'Stored', at: at(0), lastActivityAt: at(18) };
    const last: LivePromptTurn = { text: 'Repeat', response: null, at: at(2), queued: true, preceding: [first] };
    const { source } = fakeSource({ userMessages: () => stored, usageEventTimes: () => [at(1)] });
    let nowMs = Date.parse(at(20));
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, now: () => nowMs, livePrompts: { latest: () => last },
    });
    expect((await reader.prompts('s')).map((row) => row.response)).toEqual(['Stored complete text', null]);
    first.response = null;
    first.lastActivityAt = at(0);
    nowMs = Date.parse('2024-01-01T00:01:00Z');
    expect((await reader.prompts('s'))[0]).toMatchObject({ response: 'Stored complete text', answeredAt: new Date(at(1)).toISOString() });
    first.response = 'Final';
    first.completedAt = at(6);
    last.response = 'Separate final';
    last.completedAt = at(9);
    delete last.queued;
    expect((await reader.prompts('s')).map((row) => row.response)).toEqual(['Final', 'Separate final']);
  });

  it('handles hidden turns, missing times, empty bounded stores and duplicate native timestamps without stealing answers', async () => {
    const snapshot: LivePromptTurn = {
      text: 'Same', at: '', response: null, queued: true,
      preceding: [
        { text: '# Session Bootstrap Context', at: '', response: 'Hidden' },
        { text: 'Same', at: '', response: 'First answer', completedAt: null },
      ],
    };
    const { source } = fakeSource({ recentUserMessages: () => [] });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults, livePrompts: { latest: () => snapshot },
    });
    expect((await reader.recentPrompts!('s', 5)).map((row) => [row.text, row.response])).toEqual([
      ['Same', 'First answer'], ['Same', null],
    ]);
    expect(await reader.prompts('s')).toHaveLength(2);
  });

  it('keeps a single queued live row distinct from a response already being generated', async () => {
    const { source } = fakeSource({ recentUserMessages: () => [] });
    const reader = createCopilotHistoryReader({
      source, config: copilotHistoryDefaults,
      livePrompts: { latest: () => ({ text: 'Queued request', at: '', response: null, queued: true }) },
    });
    expect((await reader.recentPrompts!('s', 1))[0]).toMatchObject({ status: 'unanswered', queued: true });
    expect((await reader.prompts('s'))[0]).toMatchObject({ status: 'unanswered', queued: true });
  });
});
