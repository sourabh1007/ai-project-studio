import { describe, expect, it } from 'vitest';
import type { PrDiff, PrReviewPull } from './pr-review-contract.js';
import { buildPrReviewPrompt } from './pr-review-prompt.js';

const pull: PrReviewPull = {
  number: 42,
  title: 'Add retry logic',
  url: 'https://example.com/pr/42',
};

const diff: PrDiff = {
  baseRef: 'origin/main',
  changedFiles: 3,
  stat: ' src/client.ts | 10 ++++++',
  patch: '@@ -1 +1 @@\n-old\n+new',
  truncated: false,
};

describe('buildPrReviewPrompt', () => {
  it('embeds PR metadata, diff, and the two-section output contract', () => {
    const prompt = buildPrReviewPrompt({
      pull,
      baseBranch: 'main',
      context: 'This is a payments service.',
      diff,
      maxContextChars: 1000,
    });
    expect(prompt).toContain('#42');
    expect(prompt).toContain('Add retry logic');
    expect(prompt).toContain('Base branch: main');
    expect(prompt).toContain('Files changed: 3');
    expect(prompt).toContain('This is a payments service.');
    expect(prompt).toContain('src/client.ts');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('## PR Summary');
    expect(prompt).toContain('## Core Analysis');
  });

  it('omits the context section when none is ready and notes an unknown base', () => {
    const prompt = buildPrReviewPrompt({
      pull,
      baseBranch: null,
      context: null,
      diff,
      maxContextChars: 1000,
    });
    expect(prompt).not.toContain('## Repository context');
    expect(prompt).toContain('Base branch: unknown');
  });

  it('truncates an oversized repository context to the budget', () => {
    const prompt = buildPrReviewPrompt({
      pull,
      baseBranch: 'main',
      context: 'x'.repeat(50),
      diff,
      maxContextChars: 10,
    });
    expect(prompt).toContain(`${'x'.repeat(9)}…`);
    expect(prompt).not.toContain('x'.repeat(11));
  });

  it('marks a truncated diff and tolerates empty stat/patch', () => {
    const prompt = buildPrReviewPrompt({
      pull,
      baseBranch: 'main',
      context: null,
      diff: {
        baseRef: null,
        changedFiles: 0,
        stat: '',
        patch: '',
        truncated: true,
      },
      maxContextChars: 1000,
    });
    expect(prompt).toContain('## Diff (truncated)');
    expect(prompt).toContain('(no file statistics available)');
    expect(prompt).toContain('(empty diff)');
  });
});
