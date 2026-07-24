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
