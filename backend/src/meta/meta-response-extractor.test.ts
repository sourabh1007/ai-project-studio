import { describe, it, expect } from 'vitest';
import { extractResponseText } from './meta-response-extractor.js';
import { metaDefaults } from './config.js';
import type { Transcript } from '../session/transcript-capture.js';

function transcript(stdout: string[]): Transcript {
  return { sessionId: 'meta1', stdout, stderr: [], exitCode: 0 };
}

describe('extractResponseText', () => {
  it('returns an empty string when there is no transcript', () => {
    expect(extractResponseText(null, metaDefaults.responseTextKeys)).toBe('');
  });

  it('returns an empty string when stdout is blank', () => {
    expect(
      extractResponseText(transcript(['', '  ']), metaDefaults.responseTextKeys),
    ).toBe('');
  });

  it('reads the first matching JSON response key', () => {
    const json = JSON.stringify({ text: 'hello there' });
    expect(
      extractResponseText(transcript([json]), metaDefaults.responseTextKeys),
    ).toBe('hello there');
  });

  it('extracts the final assistant message from Copilot and Agency NDJSON', () => {
    const events = [
      JSON.stringify({ type: 'session.start', data: { id: 's1' } }),
      JSON.stringify({
        type: 'assistant.message',
        data: { content: 'draft' },
      }),
      'provider diagnostic noise',
      JSON.stringify({
        type: 'assistant.message',
        data: { content: 'final repository context' },
      }),
      JSON.stringify({ type: 'session.end', data: { usage: 42 } }),
    ];
    expect(
      extractResponseText(transcript(events), metaDefaults.responseTextKeys),
    ).toBe('final repository context');
  });

  it('joins message deltas when no final assistant message exists', () => {
    const events = [
      JSON.stringify({
        type: 'assistant.message_delta',
        data: { delta: 'first ' },
      }),
      JSON.stringify({
        type: 'assistant.message.delta',
        data: { content: 'second ' },
      }),
      JSON.stringify({
        type: 'message.delta',
        data: { message: 'third' },
      }),
    ];
    expect(
      extractResponseText(transcript(events), metaDefaults.responseTextKeys),
    ).toBe('first second third');
    expect(
      extractResponseText(
        transcript([
          JSON.stringify({
            type: 'assistant.message_delta',
            data: { content: 'only delta' },
          }),
        ]),
        metaDefaults.responseTextKeys,
      ),
    ).toBe('only delta');
    expect(
      extractResponseText(
        transcript([JSON.stringify({ type: 'assistant.message_delta' })]),
        metaDefaults.responseTextKeys,
      ),
    ).toBe('');
  });

  it('does not return a telemetry stream when it has no assistant content', () => {
    const events = [
      JSON.stringify({ type: 'session.start', data: { id: 's1' } }),
      '',
      'null',
      JSON.stringify({ type: 'tool.execution_start', data: { tool: 'x' } }),
    ];
    expect(
      extractResponseText(transcript(events), metaDefaults.responseTextKeys),
    ).toBe('');
    expect(
      extractResponseText(
        transcript([JSON.stringify({ type: 'session.end', data: {} })]),
        metaDefaults.responseTextKeys,
      ),
    ).toBe('');
    expect(
      extractResponseText(
        transcript([
          JSON.stringify({ type: 'assistant.message', data: { delta: 'done' } }),
        ]),
        metaDefaults.responseTextKeys,
      ),
    ).toBe('done');
    expect(
      extractResponseText(
        transcript([
          JSON.stringify({
            type: 'assistant.message',
            data: { content: '', delta: '', message: 'message value' },
          }),
        ]),
        metaDefaults.responseTextKeys,
      ),
    ).toBe('message value');
    expect(
      extractResponseText(
        transcript([JSON.stringify({ type: 'assistant.message' })]),
        metaDefaults.responseTextKeys,
      ),
    ).toBe('');
  });

  it('ignores empty or malformed delta events', () => {
    const events = [
      JSON.stringify({ type: 'assistant.message_delta' }),
      JSON.stringify({
        type: 'assistant.message_delta',
        data: { content: 42, delta: '' },
      }),
      JSON.stringify({
        type: 'assistant.message_delta',
        data: { content: 42, delta: '', message: 'usable' },
      }),
    ];
    expect(
      extractResponseText(transcript(events), metaDefaults.responseTextKeys),
    ).toBe('usable');
  });

  it('falls back to raw text when JSON is not an object', () => {
    expect(
      extractResponseText(transcript(['[1, 2, 3]']), metaDefaults.responseTextKeys),
    ).toBe('[1, 2, 3]');
  });

  it('returns the raw text when JSON parsing fails', () => {
    expect(
      extractResponseText(transcript(['not json']), metaDefaults.responseTextKeys),
    ).toBe('not json');
  });

  it('returns the raw text when no configured key is present', () => {
    const json = JSON.stringify({ other: 'x' });
    expect(
      extractResponseText(transcript([json]), metaDefaults.responseTextKeys),
    ).toBe(json);
  });

  it('does not clamp long responses', () => {
    const long = 'a'.repeat(5000);
    expect(
      extractResponseText(transcript([long]), metaDefaults.responseTextKeys),
    ).toBe(long);
  });
});
