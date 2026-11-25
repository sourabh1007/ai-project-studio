import { describe, it, expect } from 'vitest';
import { parseLatestLivePrompt } from './copilot-live-prompt-parser.js';

/** Default visible-text mapper: trims and hides blank content. */
const visible = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
};

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseLatestLivePrompt', () => {
  it('records the matching turn completion despite subsequent usage events', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask', messageId: 'm1', turnId: '0' }, timestamp: '2024-01-01T00:00:00Z' }),
      line({ type: 'assistant.turn_start', data: { turnId: '0' } }),
      line({ type: 'assistant.message', data: { originatingMessageId: 'm1', content: 'Done.' } }),
      line({ type: 'assistant.turn_end', data: { turnId: 'other' }, timestamp: '2024-01-01T00:00:02Z' }),
      line({ type: 'assistant.turn_end', data: { turnId: '0' }, timestamp: '2024-01-01T00:00:03Z' }),
      line({ type: 'session.usage_checkpoint', timestamp: '2024-01-01T00:00:04Z' }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'ask', at: '2024-01-01T00:00:00Z', response: 'Done.',
      completedAt: '2024-01-01T00:00:03Z', lastActivityAt: '2024-01-01T00:00:04Z',
    });
  });

  it.each([undefined, 'invalid'])('keeps completion with an unavailable timestamp (%s)', (timestamp) => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask', messageId: 'm1' } }),
      line({ type: 'assistant.turn_start' }),
      line({ type: 'assistant.turn_start', data: { turnId: 0 } }),
      line({ type: 'assistant.turn_start', data: { turnId: '0' } }),
      line({ type: 'assistant.turn_end' }),
      line({ type: 'assistant.turn_end', data: { turnId: '0' }, timestamp }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'ask', at: '', response: null, completedAt: null,
    });
  });

  it('does not confuse tool calls or another turn ending with completion of a streamed reply', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask', messageId: 'm1', turnId: '1' } }),
      line({ type: 'assistant.message', data: { originatingMessageId: 'm1', content: 'Checking…', toolRequests: [{ toolCallId: 't1' }] } }),
      line({ type: 'tool.execution_complete' }),
      line({ type: 'assistant.turn_end', data: { turnId: '0' } }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'ask', at: '', response: 'Checking…',
    });
  });

  it('does not borrow an injected turn’s completion for a visible prompt', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask', messageId: 'm1', turnId: '0' } }),
      line({ type: 'user.message', data: { content: 'INJECTED', messageId: 'm2', turnId: '1' } }),
      line({ type: 'assistant.turn_end', data: { turnId: '1' }, timestamp: '2024-01-01T00:00:03Z' }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, (text) => text === 'INJECTED' ? null : visible(text))).toEqual({
      text: 'ask', at: '', response: null,
    });
  });

  it('ignores uncorrelated completion when no turn identifier can be recovered', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask' } }),
      line({ type: 'assistant.turn_end', data: { turnId: '0' } }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).not.toHaveProperty('completedAt');
  });

  it('returns null when no user message is present', () => {
    const tail = [
      line({ type: 'assistant.message', data: { content: 'hi' } }),
      line({ type: 'tool.execution_start', data: {} }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toBeNull();
  });

  it('returns the latest user message with its timestamp and no reply yet', () => {
    const tail = [
      line({
        type: 'user.message',
        data: { content: 'first', messageId: 'm1' },
        timestamp: '2024-01-01T00:00:00Z',
      }),
      line({
        type: 'user.message',
        data: { content: 'latest prompt', messageId: 'm2' },
        timestamp: '2024-01-01T00:05:00Z',
      }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'latest prompt',
      at: '2024-01-01T00:05:00Z',
      lastActivityAt: '2024-01-01T00:05:00Z',
      response: null,
      queued: true,
      preceding: [{ text: 'first', at: '2024-01-01T00:00:00Z', lastActivityAt: '2024-01-01T00:00:00Z', response: null }],
    });
  });

  it('concatenates assistant messages for the latest turn by originatingMessageId', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'q', messageId: 'm1' }, timestamp: 't' }),
      line({ type: 'assistant.message', data: { content: 'part one', originatingMessageId: 'm1' } }),
      line({ type: 'assistant.message', data: { content: '', originatingMessageId: 'm1' } }),
      line({ type: 'tool.execution_complete', data: {} }),
      line({ type: 'assistant.message', data: { content: 'part two', originatingMessageId: 'm1' } }),
      line({ type: 'assistant.message', data: { content: 'other turn', originatingMessageId: 'mX' } }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'q',
      at: 't',
      response: 'part one\n\npart two',
    });
  });

  it('skips blank lines and unparseable (partial) leading lines', () => {
    const tail = [
      '{"type":"user.message","data":{"content":"part', // truncated by the byte window
      '',
      line({ type: 'user.message', data: { content: 'real', messageId: 'm1' }, timestamp: 't' }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'real',
      at: 't',
      response: null,
    });
  });

  it('hides injected prompts via the mapper and falls back to the latest genuine one', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'genuine ask', messageId: 'm1' }, timestamp: 't1' }),
      line({ type: 'user.message', data: { content: 'INJECTED bootstrap', messageId: 'm2' }, timestamp: 't2' }),
    ].join('\n');
    const toVisible = (text: string) =>
      text.startsWith('INJECTED') ? null : text.trim();
    expect(parseLatestLivePrompt(tail, toVisible)).toEqual({
      text: 'genuine ask',
      at: 't1',
      response: null,
    });
  });

  it('uses the mapped text so a launch prompt surfaces its unwrapped request', () => {
    const tail = [
      line({
        type: 'user.message',
        data: { content: '# Session Bootstrap Context\n\nx\n\n## User Request\n\nDo the thing', messageId: 'm1' },
        timestamp: 't',
      }),
    ].join('\n');
    const toVisible = (text: string) => {
      const marker = '## User Request\n\n';
      const idx = text.indexOf(marker);
      return idx >= 0 ? text.slice(idx + marker.length).trim() : text.trim();
    };
    expect(parseLatestLivePrompt(tail, toVisible)).toEqual({
      text: 'Do the thing',
      at: 't',
      response: null,
    });
  });

  it('treats empty/whitespace user content as absent', () => {
    const tail = [
      line({ type: 'user.message', data: { content: '   ' }, timestamp: 't' }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toBeNull();
  });

  it('tolerates non-string content/messageid/timestamp and non-object lines', () => {
    const tail = [
      '42',
      'null',
      line({ type: 'user.message', data: { content: 'ask', messageId: 99 } }),
      line({ type: 'user.message', data: { content: 42 } }),
      line({ type: 'user.message' }),
    ].join('\n');
    // Scanning from the end: the data-less message is skipped, the numeric
    // content coerces to empty and is skipped, leaving the genuine 'ask'; its
    // non-string messageId yields no reply correlation and absent timestamp ''.
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'ask',
      at: '',
      response: null,
    });
  });

  it('ignores assistant messages without data, with a wrong origin, or non-string content', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask', messageId: 'm1' }, timestamp: 't' }),
      line({ type: 'assistant.message' }),
      line({ type: 'assistant.message', data: { originatingMessageId: 'm1', content: 123 } }),
      line({ type: 'assistant.message', data: { originatingMessageId: 'other', content: 'nope' } }),
      line({ type: 'assistant.message', data: { originatingMessageId: 'm1', content: 'real reply' } }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'ask',
      at: 't',
      response: 'real reply',
    });
  });

  it('returns null response when assistant content for the turn is only whitespace', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask', messageId: 'm1' }, timestamp: 't' }),
      line({ type: 'assistant.message', data: { content: '   ', originatingMessageId: 'm1' } }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toEqual({
      text: 'ask',
      at: 't',
      response: null,
    });
  });

  it('reports the newest valid event time of the turn as last activity, ignoring bad stamps and later turns', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'ask', messageId: 'm1' }, timestamp: '2024-01-01T00:00:00Z' }),
      line({ type: 'tool.execution_start', timestamp: '2024-01-01T00:00:09Z' }),
      line({ type: 'tool.execution_complete', timestamp: 'garbage' }),
      line({ type: 'tool.execution_progress', timestamp: 42 }),
      line({ type: 'user.message', data: { content: '   ', messageId: 'hidden' }, timestamp: '2024-01-01T09:00:00Z' }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, visible)).toMatchObject({ lastActivityAt: '2024-01-01T00:00:09Z' });
  });

  it('omits last activity when no event of the turn carries a valid timestamp', () => {
    const tail = line({ type: 'user.message', data: { content: 'ask', messageId: 'm1' }, timestamp: 't' });
    expect(parseLatestLivePrompt(tail, visible)).not.toHaveProperty('lastActivityAt');
  });

  it('keeps every queued prompt and routes interleaved answers and completion to their native origin', () => {
    const events = [
      { type: 'user.message', data: { content: 'First request', messageId: 'a' }, timestamp: '2024-01-01T00:00:00Z' },
      { type: 'assistant.turn_start', data: { turnId: 'ta' } },
      { type: 'assistant.message', data: { originatingMessageId: 'a', content: 'Working on A' } },
      { type: 'user.message', data: { content: 'Second request', messageId: 'b' }, timestamp: '2024-01-01T00:00:02Z' },
      { type: 'user.message', data: { content: 'Third request', messageId: 'c' }, timestamp: '2024-01-01T00:00:03Z' },
      { type: 'assistant.message', data: { originatingMessageId: 'a', content: 'A complete' } },
      { type: 'assistant.turn_end', data: { turnId: 'ta' }, timestamp: '2024-01-01T00:00:06Z' },
    ];
    const pending = parseLatestLivePrompt(events.map(line).join('\n'), visible)!;
    expect(pending).toMatchObject({ text: 'Third request', response: null, queued: true });
    expect(pending.preceding).toMatchObject([
      { text: 'First request', response: 'Working on A\n\nA complete', completedAt: '2024-01-01T00:00:06Z' },
      { text: 'Second request', response: null, queued: true },
    ]);
    const completed = parseLatestLivePrompt([...events,
      { type: 'assistant.turn_start', data: { turnId: 'tb' } },
      { type: 'assistant.message', data: { originatingMessageId: 'b', content: 'B answer' } },
      { type: 'tool.execution_complete', data: { turnId: 'tb' }, timestamp: '2024-01-01T00:00:07Z' },
      { type: 'assistant.turn_end', data: { turnId: 'tb' }, timestamp: '2024-01-01T00:00:08Z' },
      { type: 'assistant.turn_start', data: { turnId: 'tc', originatingMessageId: 'c' } },
      { type: 'assistant.message', data: { originatingMessageId: 'c', content: 'C answer' } },
      { type: 'assistant.turn_end', data: { turnId: 'tc' }, timestamp: '2024-01-01T00:00:10Z' },
    ].map(line).join('\n'), visible)!;
    expect(completed).toMatchObject({ text: 'Third request', response: 'C answer', completedAt: '2024-01-01T00:00:10Z' });
    expect(completed).not.toHaveProperty('queued');
    expect(completed.preceding?.map((turn) => turn.response)).toEqual(['Working on A\n\nA complete', 'B answer']);
  });

  it('does not guess ownership of an ambiguous turn or uncorrelated tool activity', () => {
    const result = parseLatestLivePrompt([
      { type: 'tool.execution_complete', data: { turnId: 'absent' } },
      { type: 'tool.execution_complete' },
      { type: 'user.message', data: { content: 'A', messageId: 'a' } },
      { type: 'user.message', data: { content: 'B', messageId: 'b' } },
      { type: 'assistant.turn_start', data: { turnId: 'unbound' } },
      { type: 'tool.execution_complete', timestamp: '2024-01-01T00:00:05Z' },
      { type: 'assistant.turn_end', data: { turnId: 'unbound' }, timestamp: '2024-01-01T00:00:06Z' },
    ].map(line).join('\n'), visible)!;
    expect(result.response).toBeNull();
    expect(result.preceding?.[0].response).toBeNull();
    expect(result).not.toHaveProperty('completedAt');
    expect(result.preceding?.[0]).not.toHaveProperty('completedAt');
  });

  it('caps the live overlay at 100 turns without dropping the latest prompt', () => {
    const result = parseLatestLivePrompt(Array.from({ length: 105 }, (_, index) =>
      line({ type: 'user.message', data: { content: `Request ${index}`, messageId: `${index}` } })).join('\n'), visible)!;
    expect(result.text).toBe('Request 104');
    expect(result.preceding).toHaveLength(99);
    expect(result.preceding?.[0].text).toBe('Request 5');
  });
});
