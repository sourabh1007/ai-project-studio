import { describe, it, expect } from 'vitest';
import { extractSummaryText } from './summary-response-extractor.js';
import { summarizerDefaults } from './config.js';
import type { Transcript } from '../session/transcript-capture.js';

function transcript(stdout: string[]): Transcript {
  return { sessionId: 's1', stdout, stderr: [], exitCode: 0 };
}

describe('extractSummaryText', () => {
  const config = summarizerDefaults;

  it('returns empty string for a null transcript', () => {
    expect(extractSummaryText(null, config)).toBe('');
  });

  it('returns empty string when nothing was captured', () => {
    expect(extractSummaryText(transcript(['  ', '']), config)).toBe('');
  });

  it('reads a configured response key from JSON output', () => {
    const line = JSON.stringify({ response: '  Feature done.  ' });
    expect(extractSummaryText(transcript([line]), config)).toBe('Feature done.');
  });

  it('falls back to raw text when JSON has no matching key', () => {
    const line = JSON.stringify({ other: 'x' });
    expect(extractSummaryText(transcript([line]), config)).toBe(line);
  });

  it('falls back to raw text when JSON is not an object', () => {
    expect(extractSummaryText(transcript(['[1,2,3]']), config)).toBe('[1,2,3]');
  });

  it('returns raw text when output is not JSON', () => {
    expect(extractSummaryText(transcript(['plain summary']), config)).toBe(
      'plain summary',
    );
  });

  it('skips keys whose value is not a non-empty string', () => {
    const line = JSON.stringify({ response: '   ', text: 'from text key' });
    expect(extractSummaryText(transcript([line]), config)).toBe('from text key');
  });
});
