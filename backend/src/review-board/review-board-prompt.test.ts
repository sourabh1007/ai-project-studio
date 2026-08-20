import { describe, expect, it } from 'vitest';
import {
  buildAgentChatPrompt,
  buildFindingsPrompt,
  buildPerspectivePrompt,
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
  pull: { number: 42, title: 'Add caching', url: 'u' },
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
