import { describe, expect, it } from 'vitest';
import { parsePrReview } from './pr-review-parser.js';

describe('parsePrReview', () => {
  it('splits summary and core analysis on their headers', () => {
    const parsed = parsePrReview(
      '## PR Summary\nAdds retry logic.\n\n## Core Analysis\n- Wraps the client\n- Adds a timeout',
    );
    expect(parsed.summary).toBe('Adds retry logic.');
    expect(parsed.coreAnalysis).toBe('- Wraps the client\n- Adds a timeout');
  });

  it('treats the whole text as the summary when no core header is present', () => {
    const parsed = parsePrReview('## Summary\nJust a small doc fix.');
    expect(parsed.summary).toBe('Just a small doc fix.');
    expect(parsed.coreAnalysis).toBeNull();
  });

  it('falls back to the raw text as summary with no headers at all', () => {
    const parsed = parsePrReview('A freeform description with no headings.');
    expect(parsed.summary).toBe('A freeform description with no headings.');
    expect(parsed.coreAnalysis).toBeNull();
  });

  it('returns null sections when a section is empty', () => {
    const parsed = parsePrReview('## PR Summary\n\n## Core Analysis\n');
    expect(parsed.summary).toBeNull();
    expect(parsed.coreAnalysis).toBeNull();
  });
});
