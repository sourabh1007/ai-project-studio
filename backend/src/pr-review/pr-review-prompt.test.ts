import { describe, expect, it } from 'vitest';
import type { PrReviewPull } from './pr-review-contract.js';
import {
  buildFileExplanationPrompt,
  buildProblemStatementPrompt,
} from './pr-review-prompt.js';

const pull: PrReviewPull = {
  number: 7,
  title: 'Add retry logic',
  url: 'https://example.com/pr/7',
};

describe('buildProblemStatementPrompt', () => {
  it('embeds the description and asks for the problem heading', () => {
    const prompt = buildProblemStatementPrompt({
      pull,
      baseBranch: 'main',
      description: 'Users lose data on retry.',
    });
    expect(prompt).toContain('## Problem Statement');
    expect(prompt).toContain('Users lose data on retry.');
    expect(prompt).toContain('INSUFFICIENT');
    expect(prompt).toContain('#7');
    expect(prompt).toContain('Base branch: main');
  });

  it('notes when no description was provided and base branch is unknown', () => {
    const prompt = buildProblemStatementPrompt({
      pull,
      baseBranch: null,
      description: null,
    });
    expect(prompt).toContain('(no description provided)');
    expect(prompt).toContain('Base branch: unknown');
  });
});

describe('buildFileExplanationPrompt', () => {
  it('embeds the file, change kind, problem and diff, and asks for JSON', () => {
    const prompt = buildFileExplanationPrompt({
      path: 'src/a.ts',
      changeKind: 'modified',
      problemStatement: 'Requests fail transiently.',
      diff: '@@ -1 +1 @@\n-old\n+new',
      budget: { maxContextChars: 100 },
    });
    expect(prompt).toContain('Path: src/a.ts');
    expect(prompt).toContain('Change: modified');
    expect(prompt).toContain('Requests fail transiently.');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('+new');
    expect(prompt).toContain('"whatItDoes"');
    expect(prompt).toContain('"whatChanged"');
    expect(prompt).toContain('"review"');
  });

  it('clamps an oversized diff to the budget and notes an empty diff', () => {
    const clamped = buildFileExplanationPrompt({
      path: 'src/a.ts',
      changeKind: 'added',
      problemStatement: 'P',
      diff: 'X'.repeat(50),
      budget: { maxContextChars: 10 },
    });
    expect(clamped).toContain('…');

    const empty = buildFileExplanationPrompt({
      path: 'src/a.ts',
      changeKind: 'added',
      problemStatement: 'P',
      diff: '   ',
      budget: { maxContextChars: 100 },
    });
    expect(empty).toContain('(empty diff)');
  });
});
