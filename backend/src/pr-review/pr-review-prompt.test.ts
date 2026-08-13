import { describe, expect, it } from 'vitest';
import { prReviewDefaults } from './config.js';
import type { PrReviewPull } from './pr-review-contract.js';
import {
  buildFileExplanationPrompt,
  buildProblemStatementPrompt,
} from './pr-review-prompt.js';

const config = prReviewDefaults;

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
      config,
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
      config,
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
      config,
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
      config,
    });
    expect(clamped).toContain('…');

    const empty = buildFileExplanationPrompt({
      path: 'src/a.ts',
      changeKind: 'added',
      problemStatement: 'P',
      diff: '   ',
      budget: { maxContextChars: 100 },
      config,
    });
    expect(empty).toContain('(empty diff)');
  });

  it('asks for a per-test-method breakdown and lists the changed methods for a test file', () => {
    const prompt = buildFileExplanationPrompt({
      path: 'src/a.test.ts',
      changeKind: 'modified',
      problemStatement: 'P',
      diff: "@@ -1,2 +1,3 @@\n it('adds two', () => {\n+  expect(2).toBe(2);\n });",
      budget: { maxContextChars: 500 },
      config,
      isTest: true,
    });
    expect(prompt).toContain('"methods"');
    expect(prompt).toContain('This is a TEST file');
    expect(prompt).toContain('"adds two"');
    expect(prompt).toContain('Explain each of these.');
  });

  it('still requests a methods array for a test file with no identifiable method', () => {
    const prompt = buildFileExplanationPrompt({
      path: 'src/a.test.ts',
      changeKind: 'added',
      problemStatement: 'P',
      diff: '+import os',
      budget: { maxContextChars: 500 },
      config,
      isTest: true,
    });
    expect(prompt).toContain('"methods"');
    expect(prompt).toContain('Use [] if the diff changes no identifiable test');
  });

  it('omits the per-test-method breakdown for a code file', () => {
    const prompt = buildFileExplanationPrompt({
      path: 'src/a.ts',
      changeKind: 'modified',
      problemStatement: 'P',
      diff: '@@ -1 +1 @@\n-old\n+new',
      budget: { maxContextChars: 100 },
      config,
      isTest: false,
    });
    expect(prompt).not.toContain('"methods"');
    expect(prompt).not.toContain('This is a TEST file');
  });
});

