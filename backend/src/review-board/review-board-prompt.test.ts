import { describe, expect, it } from 'vitest';
import {
  buildAgentChatPrompt,
  buildFindingsPrompt,
  buildPerspectivePrompt,
  buildProblemSolutionPrompt,
  buildSolutionDigest,
  type SolutionNode,
} from './review-board-prompt.js';
import type {
  ProjectModel,
  ReviewBoard,
  ReviewPerspective,
} from './review-board-contract.js';

const model: ProjectModel = {
  projectType: 'Backend service',
  projectTypeConfidence: 0.8,
  primaryLanguages: ['C#'],
  secondaryLanguages: [],
  changedComponents: ['Cache'],
  changedModules: [],
  changedRuntimePaths: ['Product'],
  configurationSystems: [],
  testSignals: [],
  deploymentModel: '',
  contracts: [],
  blastRadiusDimensions: ['Components'],
  perspectives: [],
  confidence: 0.6,
  evidence: [],
};

const perspective: ReviewPerspective = {
  id: 'security',
  name: 'Security',
  why: 'Every change must be reviewed for security impact.',
  source: 'core',
  status: 'warning',
  risk: 'medium',
  findings: [
    {
      id: 'security/ai-0',
      perspectiveId: 'security',
      title: 'Unvalidated input',
      detail: 'Validate the cache key.',
      severity: 'high',
      status: 'blocked',
      evidence: [],
    },
  ],
};

const board: ReviewBoard = {
  featureId: 'f1',
  pull: { number: 42, title: 'Add caching', url: 'u', headSha: null },
  worktreePath: 'w',
  baseBranch: 'main',
  changedFiles: 3,
  model,
  perspectives: [perspective],
  recommendation: 'needs-review',
  summary: { open: 1, blocking: 1, warnings: 0, suggestions: 0 },
  generatedAt: 't',
};

describe('buildFindingsPrompt', () => {
  it('includes pull, model digest, changed files and the perspective menu', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: 'Adds a cache layer.',
      changedPaths: ['src/Cache.cs', 'src/CacheKey.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('#42');
    expect(prompt).toContain('Backend service');
    expect(prompt).toContain('- security: Security');
    expect(prompt).toContain('Adds a cache layer.');
    expect(prompt).toContain('one of [security]');
    expect(prompt).toContain('## Changed files');
    expect(prompt).toContain('- src/Cache.cs');
    expect(prompt).toContain('no generic review');
  });

  it('falls back to a placeholder when the description is blank', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: '   ',
      changedPaths: ['a.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('(no description provided)');
  });

  it('handles a null description', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: null,
      changedPaths: ['a.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('(no description provided)');
  });

  it('clamps a very long description', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: 'x'.repeat(100),
      changedPaths: ['a.cs'],
      config: { maxContextChars: 10 },
    });
    expect(prompt).toContain('…');
  });

  it('notes when no changed files were resolved', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: 'd',
      changedPaths: [],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('(no changed files were resolved');
  });

  it('truncates a very long changed-files list', () => {
    const many = Array.from({ length: 90 }, (_, i) => `src/f${i}.cs`);
    const prompt = buildFindingsPrompt({
      board,
      description: 'd',
      changedPaths: many,
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('…and 10 more changed file(s)');
    expect(prompt).not.toContain('src/f85.cs');
  });

  it('renders "none" fallbacks and unknown base branch for a bare model', () => {
    const bareModel: ProjectModel = {
      ...model,
      primaryLanguages: [],
      secondaryLanguages: [],
      changedComponents: [],
      blastRadiusDimensions: [],
      deploymentModel: '',
    };
    const prompt = buildFindingsPrompt({
      board: { ...board, model: bareModel, baseBranch: null },
      description: 'd',
      changedPaths: ['a.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('Languages: none detected');
    expect(prompt).toContain('Changed components (0): none');
    expect(prompt).toContain('Blast-radius dimensions: none');
    expect(prompt).toContain('Base branch: unknown');
  });
});

describe('buildPerspectivePrompt', () => {
  it('scopes to one lens and requests the skip/findings object', () => {
    const prompt = buildPerspectivePrompt({
      board,
      perspective,
      description: 'Adds a cache layer.',
      changedPaths: ['src/Cache.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('Review lens: Security');
    expect(prompt).toContain(
      'Every change must be reviewed for security impact.',
    );
    expect(prompt).toContain('#42');
    expect(prompt).toContain('"skipped": boolean');
    expect(prompt).toContain('"summary": string — REQUIRED');
    expect(prompt).toContain('"rationale": [');
    expect(prompt).toContain('"checks": [');
    expect(prompt).toContain('Adds a cache layer.');
    expect(prompt).toContain('- src/Cache.cs');
    expect(prompt).toContain('no generic review');
  });

  it('falls back to a placeholder for a null description', () => {
    const prompt = buildPerspectivePrompt({
      board,
      perspective,
      description: null,
      changedPaths: ['a.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('(no description provided)');
  });

  it('reports an unknown base branch', () => {
    const prompt = buildPerspectivePrompt({
      board: { ...board, baseBranch: null },
      perspective,
      description: 'd',
      changedPaths: ['a.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('Base branch: unknown');
  });

  it('notes when no changed files were resolved', () => {
    const prompt = buildPerspectivePrompt({
      board,
      perspective,
      description: 'd',
      changedPaths: [],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('(no changed files were resolved');
  });

  it('forbids an approved verdict without evidence', () => {
    const prompt = buildPerspectivePrompt({
      board,
      perspective,
      description: 'd',
      changedPaths: ['a.cs'],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('with an empty rationale or empty checks is');
    expect(prompt).toContain('never assume "green"');
  });

  it('clamps a very long description', () => {
    const prompt = buildPerspectivePrompt({
      board,
      perspective,
      description: 'x'.repeat(100),
      changedPaths: ['a.cs'],
      config: { maxContextChars: 10 },
    });
    expect(prompt).toContain('…');
  });
});

function solNode(overrides: Partial<SolutionNode> = {}): SolutionNode {
  return {
    path: 'src/Cache.cs',
    module: 'Cache',
    category: 'code',
    kind: 'changed',
    changeKind: 'modified',
    whatChanged: '',
    whatItDoes: '',
    diff: '',
    ...overrides,
  };
}

describe('buildSolutionDigest', () => {
  it('notes when no changed files resolve', () => {
    const digest = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ kind: 'boundary' })],
      maxChars: 20_000,
    });
    expect(digest).toContain('(no changed files were resolved');
  });

  it('counts code/test and prefers distilled whatChanged', () => {
    const digest = buildSolutionDigest({
      title: 'Add caching',
      nodes: [
        solNode({ path: 'a.cs', whatChanged: 'Adds an LRU cache.' }),
        solNode({ path: 'a.test.cs', category: 'test' }),
      ],
      maxChars: 20_000,
    });
    expect(digest).toContain('PR "Add caching" changes 2 file(s) — 1 code, 1 test.');
    expect(digest).toContain('- a.cs (Cache) — modified');
    expect(digest).toContain('Adds an LRU cache.');
  });

  it('falls back to a bounded diff, then whatItDoes, then nothing', () => {
    const diffDigest = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ diff: 'y'.repeat(800) })],
      maxChars: 20_000,
    });
    expect(diffDigest).toContain('…');
    const roleDigest = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ whatItDoes: 'Holds cache entries.' })],
      maxChars: 20_000,
    });
    expect(roleDigest).toContain('Existing role: Holds cache entries.');
    const bare = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ module: null, changeKind: null })],
      maxChars: 20_000,
    });
    expect(bare).toContain('- src/Cache.cs');
    expect(bare).not.toContain('  '); // no signal line
  });

  it('caps the enumerated files and records an overflow row', () => {
    const nodes = Array.from({ length: 61 }, (_, i) => solNode({ path: `f${i}.cs` }));
    const digest = buildSolutionDigest({ title: 'PR', nodes, maxChars: 20_000 });
    expect(digest).toContain('…and 1 more changed file(s)');
  });

  it('clamps the whole digest to maxChars', () => {
    const digest = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ whatChanged: 'z'.repeat(500) })],
      maxChars: 40,
    });
    expect(digest.length).toBeLessThanOrEqual(40);
    expect(digest).toContain('…');
  });
});

describe('buildProblemSolutionPrompt', () => {
  it('asks for a general problem/solution verdict fed the distilled problem', () => {
    const prompt = buildProblemSolutionPrompt({
      board,
      perspective,
      description: 'Adds a cache layer.',
      problemStatement: 'Reads are slow.',
      problemSufficient: true,
      solutionDigest: 'PR "Add caching" changes 1 file(s).',
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('does this pull request');
    expect(prompt).toContain('Do NOT evaluate files');
    expect(prompt).toContain('Distilled problem statement:');
    expect(prompt).toContain('Reads are slow.');
    expect(prompt).toContain('Adds a cache layer.');
    expect(prompt).toContain('"label": "Problem"');
    expect(prompt).toContain('"label": "Why they align"');
    expect(prompt).toContain('"checks": []');
    expect(prompt).toContain('PR "Add caching" changes 1 file(s).');
  });

  it('notes when no distilled problem statement is available', () => {
    const insufficient = buildProblemSolutionPrompt({
      board,
      perspective,
      description: 'd',
      problemStatement: 'partial',
      problemSufficient: false,
      solutionDigest: 's',
      config: { maxContextChars: 20_000 },
    });
    expect(insufficient).toContain('no self-contained problem statement');
    const missing = buildProblemSolutionPrompt({
      board,
      perspective,
      description: null,
      problemStatement: null,
      problemSufficient: true,
      solutionDigest: 's',
      config: { maxContextChars: 20_000 },
    });
    expect(missing).toContain('no self-contained problem statement');
    expect(missing).toContain('(no description provided)');
  });

  it('clamps a very long distilled problem statement', () => {
    const prompt = buildProblemSolutionPrompt({
      board,
      perspective,
      description: 'd',
      problemStatement: 'p'.repeat(100),
      problemSufficient: true,
      solutionDigest: 's',
      config: { maxContextChars: 10 },
    });
    expect(prompt).toContain('…');
  });
});

describe('buildAgentChatPrompt', () => {
  it('embeds the focused perspective and transcript', () => {
    const prompt = buildAgentChatPrompt({
      board,
      perspective,
      messages: [
        { role: 'user', content: 'Why blocked?' },
        { role: 'assistant', content: 'Because...' },
        { role: 'user', content: 'Explain more.' },
      ],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('Focused perspective: Security');
    expect(prompt).toContain('Unvalidated input');
    expect(prompt).toContain('User: Why blocked?');
    expect(prompt).toContain('Assistant: Because...');
  });

  it('includes the rating-change protocol only when a perspective is focused', () => {
    const focused = buildAgentChatPrompt({
      board,
      perspective,
      messages: [{ role: 'user', content: 'Hi' }],
      config: { maxContextChars: 20_000 },
    });
    expect(focused).toContain('Changing this rating');
    expect(focused).toContain('do NOT change a rating on assertion');
    const whole = buildAgentChatPrompt({
      board,
      perspective: null,
      messages: [{ role: 'user', content: 'Hi' }],
      config: { maxContextChars: 20_000 },
    });
    expect(whole).not.toContain('Changing this rating');
  });

  it('omits the focus block when no perspective is selected', () => {
    const prompt = buildAgentChatPrompt({
      board,
      perspective: null,
      messages: [{ role: 'user', content: 'Summarize.' }],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).not.toContain('Focused perspective');
    expect(prompt).toContain('Engineering Review Agent');
  });

  it('notes when a focused perspective has no findings', () => {
    const prompt = buildAgentChatPrompt({
      board,
      perspective: { ...perspective, findings: [] },
      messages: [{ role: 'user', content: 'Hi' }],
      config: { maxContextChars: 20_000 },
    });
    expect(prompt).toContain('none recorded yet');
  });

  it('clamps the full prompt to the context budget', () => {
    const prompt = buildAgentChatPrompt({
      board,
      perspective: null,
      messages: [{ role: 'user', content: 'Hi' }],
      config: { maxContextChars: 20 },
    });
    expect(prompt.length).toBeLessThanOrEqual(20);
  });
});
