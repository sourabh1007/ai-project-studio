import { describe, it, expect } from 'vitest';
import { createTranscriptCapture } from './transcript-capture.js';

describe('transcript-capture', () => {
  it('folds stdout, stderr and exit into a transcript', () => {
    const capture = createTranscriptCapture('sess-1');
    capture.record({ type: 'stdout', line: 'a' });
    capture.record({ type: 'stderr', line: 'e' });
    capture.record({ type: 'stdout', line: 'b' });
    capture.record({ type: 'exit', code: 0 });

    expect(capture.result()).toEqual({
      sessionId: 'sess-1',
      stdout: ['a', 'b'],
      stderr: ['e'],
      exitCode: 0,
    });
  });

  it('returns independent copies of the accumulated arrays', () => {
    const capture = createTranscriptCapture('sess-1');
    capture.record({ type: 'stdout', line: 'a' });
    const first = capture.result();
    capture.record({ type: 'stdout', line: 'b' });
    expect(first.stdout).toEqual(['a']);
    expect(capture.result().stdout).toEqual(['a', 'b']);
  });

  it('defaults exitCode to null before exit', () => {
    const capture = createTranscriptCapture('sess-1');
    expect(capture.result().exitCode).toBeNull();
  });
});
