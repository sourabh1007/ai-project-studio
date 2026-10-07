import { describe, it, expect } from 'vitest';
import { parseLatestLivePrompt } from './copilot-live-prompt-parser.js';

const never = () => false;

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseLatestLivePrompt', () => {
  it('returns null when no user message is present', () => {
    const tail = [
      line({ type: 'assistant.message', data: { content: 'hi' } }),
      line({ type: 'tool.execution_start', data: {} }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, never)).toBeNull();
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
    expect(parseLatestLivePrompt(tail, never)).toEqual({
      text: 'latest prompt',
      at: '2024-01-01T00:05:00Z',
      response: null,
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
    expect(parseLatestLivePrompt(tail, never)).toEqual({
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
    expect(parseLatestLivePrompt(tail, never)).toEqual({
      text: 'real',
      at: 't',
      response: null,
    });
  });

  it('ignores injected prompts and falls back to the latest genuine one', () => {
    const tail = [
      line({ type: 'user.message', data: { content: 'genuine ask', messageId: 'm1' }, timestamp: 't1' }),
      line({ type: 'user.message', data: { content: 'INJECTED bootstrap', messageId: 'm2' }, timestamp: 't2' }),
    ].join('\n');
    const isInjected = (text: string) => text.startsWith('INJECTED');
    expect(parseLatestLivePrompt(tail, isInjected)).toEqual({
      text: 'genuine ask',
      at: 't1',
      response: null,
    });
  });

  it('treats empty/whitespace user content as absent', () => {
    const tail = [
      line({ type: 'user.message', data: { content: '   ' }, timestamp: 't' }),
    ].join('\n');
    expect(parseLatestLivePrompt(tail, never)).toBeNull();
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
    expect(parseLatestLivePrompt(tail, never)).toEqual({
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
    expect(parseLatestLivePrompt(tail, never)).toEqual({
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
    expect(parseLatestLivePrompt(tail, never)).toEqual({
      text: 'ask',
      at: 't',
      response: null,
    });
  });
});
