import { describe, expect, it } from 'vitest';
import { prReviewDefaults } from './config.js';
import type {
  ChangeGraphEdge,
  ChangeGraphNode,
  ChangeGraphProject,
  PrReviewChatMessage,
  PrReviewPull,
} from './pr-review-contract.js';
import {
  buildChangeGraphChatPrompt,
  buildFileExplanationPrompt,
  buildProblemStatementPrompt,
  summarizeChangeGraph,
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

function node(over: Partial<ChangeGraphNode>): ChangeGraphNode {
  return {
    path: 'src/a.cs',
    projectId: 'p1',
    module: null,
    category: 'code',
    kind: 'changed',
    changeKind: 'modified',
    diff: '',
    whatItDoes: '',
    whatChanged: '',
    review: [],
    ...over,
  };
}

describe('summarizeChangeGraph', () => {
  const projects: ChangeGraphProject[] = [
    { id: 'p1', name: 'Core', path: 'src/Core.csproj' },
    { id: 'p2', name: 'Api', path: 'src/Api.csproj' },
  ];
  const nodes: ChangeGraphNode[] = [
    node({ path: 'src/Core/A.cs', projectId: 'p1', whatChanged: 'Adds retry.' }),
    node({ path: 'src/Api/B.cs', projectId: 'p2', changeKind: 'added' }),
    node({ path: 'src/Api/Caller.cs', projectId: 'p2', kind: 'boundary', changeKind: null }),
    // An orphan file whose project has no declared name and no change kind:
    // exercises the id fallback and the "changed" default label.
    node({ path: 'src/Orphan/O.cs', projectId: 'pX', changeKind: null }),
    node({ path: 'test/T.cs', projectId: 'p1', category: 'test' }),
  ];
  const edges: ChangeGraphEdge[] = [
    { from: 'src/Api/B.cs', to: 'src/Core/A.cs', calls: [{ symbol: 'A', caller: 'B' }] },
    // A reference with no recorded symbols renders without the "(uses …)" suffix.
    { from: 'src/Api/B.cs', to: 'src/Orphan/O.cs', calls: [] },
    { from: 'x', to: 'y', calls: [] },
  ];

  it('groups changed files by module and lists callers and references', () => {
    const text = summarizeChangeGraph({
      category: 'code',
      problemStatement: 'Improve retry.',
      projects,
      nodes,
      edges,
    });
    expect(text).toContain('## Change graph (code)');
    expect(text).toContain('Problem statement: Improve retry.');
    expect(text).toContain('Core (1 file(s))');
    expect(text).toContain('src/Core/A.cs [modified] — Adds retry.');
    expect(text).toContain('src/Api/B.cs [added]');
    expect(text).toContain('src/Api/Caller.cs');
    // Unknown project falls back to its id; a null change kind reads "changed".
    expect(text).toContain('pX (1 file(s))');
    expect(text).toContain('src/Orphan/O.cs [changed]');
    expect(text).toContain('src/Api/B.cs → src/Core/A.cs (uses A)');
    // The symbol-less edge is listed with no "(uses …)" suffix.
    expect(text).toContain('- src/Api/B.cs → src/Orphan/O.cs');
    expect(text).not.toContain('src/Orphan/O.cs (uses');
    // The test file must not leak into the code summary.
    expect(text).not.toContain('test/T.cs');
  });

  it('notes when a category has no changed files, callers or references', () => {
    const text = summarizeChangeGraph({
      category: 'test',
      problemStatement: 'P',
      projects,
      nodes: [],
      edges: [],
    });
    expect(text).toContain('0 changed test file(s)');
    expect(text).toContain('(none)');
    expect(text).toContain('(none discovered)');
  });
});

describe('buildChangeGraphChatPrompt', () => {
  const base = {
    category: 'code' as const,
    graphSummary: '## Change graph (code)\nProblem statement: P',
    budget: { maxContextChars: 500 },
    config,
  };

  it('embeds the summary, prior turns and the latest question', () => {
    const messages: PrReviewChatMessage[] = [
      { role: 'user', content: 'What changed?' },
      { role: 'assistant', content: 'Two files.' },
      { role: 'user', content: 'Which module?' },
    ];
    const prompt = buildChangeGraphChatPrompt({ ...base, messages });
    expect(prompt).toContain('## Change graph (code)');
    expect(prompt).toContain('Reviewer: What changed?');
    expect(prompt).toContain('Assistant: Two files.');
    expect(prompt).toContain('## Reviewer question\nWhich module?');
  });

  it('uses the no-history placeholder for the first question and clamps the summary', () => {
    const prompt = buildChangeGraphChatPrompt({
      ...base,
      graphSummary: 'S'.repeat(50),
      budget: { maxContextChars: 10 },
      messages: [{ role: 'user', content: 'Overview?' }],
    });
    expect(prompt).toContain(prReviewDefaults.graphChatNoHistoryPlaceholder);
    expect(prompt).toContain('…');
  });

  it('tolerates an empty messages array', () => {
    const prompt = buildChangeGraphChatPrompt({ ...base, messages: [] });
    expect(prompt).toContain('## Reviewer question');
  });
});

