import { describe, expect, it } from 'vitest';
import {
  buildAgentChatPrompt,
  buildCommonPromptVars,
  buildFindingsPrompt,
  buildSolutionDigest,
  reviewedSolution,
  reviewedProblem,
  reviewContextText,
  existingDiscussionSection,
  renderExistingDiscussion,
  type ExistingCommentThread,
  type SolutionNode,
} from './review-board-prompt.js';
import type {
  ProjectModel,
  ReviewBoard,
  ReviewPerspective,
  PerspectiveAnalysis,
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

describe('human-readable reviewed solution', () => {
  const result = (label: string, detail: string, skipped = false) => ({
    skipped, rationale: [{ label, detail }],
  } as PerspectiveAnalysis);
  it('prefers the solution analysis and falls back to a completed architecture explanation', () => {
    const architecture = result('Flow', 'The lock resolver cancels work before taking ownership.');
    expect(reviewedSolution({ architecture, 'problem-solution': result('Solution implemented', '  Cancel the old work first.  ') }))
      .toBe('Cancel the old work first.');
    expect(reviewedSolution({ architecture })).toBe(architecture.rationale[0].detail);
    expect(reviewedSolution({ architecture, 'problem-solution': result('Implementation', 'Skipped', true) }))
      .toBe(architecture.rationale[0].detail);
  });
  it('never presents a filename inventory, a blank rationale, or a proposed fix as the implemented solution', () => {
    const cases: Record<string, PerspectiveAnalysis>[] = [{}, { architecture: result('Fix', 'Proposed fix') },
      { 'problem-solution': result('Solution', '  ') }];
    for (const analyses of cases) {
      expect(reviewedSolution(analyses)).toContain('has not explained the solution yet');
    }
  });
  it('uses the captured diff when a summary is only a placeholder', () => {
    expect(buildSolutionDigest({ title: 'Retry', nodes: [{ path: 'a.ts', kind: 'changed', category: 'code',
      module: null, changeKind: 'modified', whatChanged: 'No change summary was produced.', whatItDoes: '', diff: '-old\n+new' }] }))
      .toContain('-old\n+new');
  });
  it('renders grounded problem and solution ASCII diagrams without changing their spacing', () => {
    const analysis = result('Problem', 'A retry can charge the same purchase twice.');
    analysis.rationale.push({ label: 'Problem diagram', detail: '[Retry] -> [Second charge]' },
      { label: 'Solution implemented', detail: 'Keep one operation key across retries.' },
      { label: 'Solution diagram', detail: '[Retry]\n   |\n   v\n[Same key] -> [Original receipt]' });
    expect(reviewedProblem({ 'problem-solution': analysis }, 'Original description'))
      .toBe('A retry can charge the same purchase twice.\n\n```text\n[Retry] -> [Second charge]\n```');
    expect(reviewedSolution({ 'problem-solution': analysis }))
      .toContain('```text\n[Retry]\n   |\n   v\n[Same key] -> [Original receipt]\n```');
    analysis.rationale[1].detail = analysis.rationale[0].detail;
    expect(reviewedProblem({ 'problem-solution': analysis }, 'Original description')).toBe(analysis.rationale[0].detail);
    expect(reviewedProblem({}, 'Original description')).toBe('Original description');
  });
  it('removes generated import bookkeeping, never treats it as a problem, and preserves real requirements', () => {
    const bookkeeping = 'Reviewing 2 pull requests from Example/Repo.\n\nImport reference: 8aa8731e-8423-4835-b4c2-c78d65050315';
    expect(reviewContextText(bookkeeping)).toBe('');
    expect(reviewContextText(`${bookkeeping}\r\n\r\nKeep operation keys stable.`)).toBe('Keep operation keys stable.');
    expect(reviewContextText('Reviewing the retry flow must preserve its key.')).toBe('Reviewing the retry flow must preserve its key.');
    expect(reviewedProblem({}, bookkeeping)).toContain('problem has not been explained yet');
  });
});

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
  repoId: 'r1',
  pull: { number: 42, title: 'Add caching', url: 'u', headSha: null },
  worktreePath: 'w',
  baseBranch: 'main',
  changedFiles: 3,
  model,
  perspectives: [perspective],
  recommendation: 'needs-review',
  summary: { open: 1, blocking: 1, warnings: 0, suggestions: 0 },
  reviewUpdatedAt: 't0',
  generatedAt: 't',
};

describe('buildFindingsPrompt', () => {
  it('requests only known captured-diff coordinates and keeps legacy citations', () => {
    const prompt = buildFindingsPrompt({
      board, description: null, changedPaths: [],
    });
    expect(prompt).toContain('"location": { "path": "<repo-relative path>", "line": 1');
    expect(prompt).toContain('"side": "RIGHT" | "LEFT"');
    expect(prompt).toContain('ONLY when exact coordinates are known from the captured diff');
    expect(prompt).toContain('set "location" to null or omit it. Never invent coordinates');
    expect(prompt).toContain('Deletions belong on LEFT');
    expect(prompt).toContain('Keep "source" as the human-readable citation');
  });
  it('includes pull, model digest, changed files and the perspective menu', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: 'Adds a cache layer.',
      changedPaths: ['src/Cache.cs', 'src/CacheKey.cs'],
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
    });
    expect(prompt).toContain('(no description provided)');
  });

  it('handles a null description', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: null,
      changedPaths: ['a.cs'],
    });
    expect(prompt).toContain('(no description provided)');
  });

  it('retains a description beyond the former IDE context cap', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: 'x'.repeat(30_000),
      changedPaths: ['a.cs'],
    });
    expect(prompt).toContain('x'.repeat(30_000));
  });

  it('notes when no changed files were resolved', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: 'd',
      changedPaths: [],
    });
    expect(prompt).toContain('(no changed files were resolved');
  });

  it('retains every captured changed file', () => {
    const many = Array.from({ length: 90 }, (_, i) => `src/f${i}.cs`);
    const prompt = buildFindingsPrompt({
      board,
      description: 'd',
      changedPaths: many,
    });
    expect(prompt).toContain('src/f89.cs');
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
    });
    expect(prompt).toContain('Languages: none detected');
    expect(prompt).toContain('Changed components (0): none');
    expect(prompt).toContain('Blast-radius dimensions: none');
    expect(prompt).toContain('Base branch: unknown');
  });

  it('omits the existing-discussion section when there are no threads', () => {
    const prompt = buildFindingsPrompt({
      board,
      description: 'd',
      changedPaths: ['a.cs'],
      existingThreads: [],
    });
    expect(prompt).not.toContain('Existing PR discussion');
  });

  it('renders existing threads and the account-for-them instructions', () => {
    const existingThreads: ExistingCommentThread[] = [
      {
        path: 'src/Cache.cs',
        line: 12,
        status: 'active',
        comments: [
          { author: 'alice', body: 'Validate the cache key here.' },
          { author: 'bob', body: 'Good point, will fix.' },
        ],
      },
    ];
    const prompt = buildFindingsPrompt({
      board,
      description: 'd',
      changedPaths: ['src/Cache.cs'],
      existingThreads,
    });
    expect(prompt).toContain('## Existing PR discussion');
    expect(prompt).toContain('[active] src/Cache.cs:12');
    expect(prompt).toContain('alice: Validate the cache key here.');
    expect(prompt).toContain('bob: Good point, will fix.');
    expect(prompt).toContain('Retain a finding');
    expect(prompt).toContain('not proof of a code fix');
  });
});

describe('renderExistingDiscussion', () => {
  it('returns an empty string when there are no threads', () => {
    expect(renderExistingDiscussion([])).toBe('');
    expect(existingDiscussionSection([])).toBe('');
  });

  it('labels PR-level threads and falls back to "reviewer" for blank authors', () => {
    const rendered = renderExistingDiscussion(
      [
        {
          path: null,
          line: null,
          status: 'resolved',
          comments: [{ author: '   ', body: 'General note.' }],
        },
      ],
    );
    expect(rendered).toContain('[resolved] PR-level discussion');
    expect(rendered).toContain('reviewer: General note.');
  });

  it('anchors on path only when the line is unknown', () => {
    const rendered = renderExistingDiscussion(
      [
        {
          path: 'src/a.cs',
          line: null,
          status: 'active',
          comments: [{ author: 'ann', body: 'Look here.' }],
        },
      ],
    );
    expect(rendered).toContain('[active] src/a.cs');
    expect(rendered).not.toContain('src/a.cs:');
  });

  it('retains complete comment bodies', () => {
    const rendered = renderExistingDiscussion(
      [
        {
          path: 'src/a.cs',
          line: 1,
          status: 'active',
          comments: [{ author: 'ann', body: 'x'.repeat(1000) }],
        },
      ],
    );
    expect(rendered).toContain('x'.repeat(1000));
  });

  it('retains every captured thread', () => {
    const threads: ExistingCommentThread[] = Array.from(
      { length: 55 },
      (_, i) => ({
        path: `src/f${i}.cs`,
        line: 1,
        status: 'active' as const,
        comments: [{ author: 'ann', body: `note ${i}` }],
      }),
    );
    const rendered = renderExistingDiscussion(threads);
    expect(rendered).toContain('src/f54.cs');
  });
});

describe('buildCommonPromptVars', () => {
  it('maps the lens, PR facts and evidence into substitution values', () => {
    const vars = buildCommonPromptVars({
      board,
      perspective,
      description: 'Adds a cache layer.',
      changedPaths: ['src/Cache.cs'],
    });
    expect(vars.lensName).toBe('Security');
    expect(vars.lensPurpose).toBe(
      'Every change must be reviewed for security impact.',
    );
    expect(vars.prNumber).toBe('42');
    expect(vars.prTitle).toBe('Add caching');
    expect(vars.baseBranch).toBe('main');
    expect(vars.filesChanged).toBe('3');
    expect(vars.description).toBe('Adds a cache layer.');
    expect(vars.modelDigest).toContain('Backend service');
    expect(vars.changedFiles).toContain('- src/Cache.cs');
  });

  it('falls back to a placeholder for a null description', () => {
    const vars = buildCommonPromptVars({
      board,
      perspective,
      description: null,
      changedPaths: ['a.cs'],
    });
    expect(vars.description).toBe('(no description provided)');
  });

  it('reports an unknown base branch', () => {
    const vars = buildCommonPromptVars({
      board: { ...board, baseBranch: null },
      perspective,
      description: 'd',
      changedPaths: ['a.cs'],
    });
    expect(vars.baseBranch).toBe('unknown');
  });

  it('notes when no changed files were resolved', () => {
    const vars = buildCommonPromptVars({
      board,
      perspective,
      description: 'd',
      changedPaths: [],
    });
    expect(vars.changedFiles).toContain('(no changed files were resolved');
  });

  it('retains a complete description', () => {
    const vars = buildCommonPromptVars({
      board,
      perspective,
      description: 'x'.repeat(100),
      changedPaths: ['a.cs'],
    });
    expect(vars.description).toBe('x'.repeat(100));
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
    });
    expect(digest).toContain('PR "Add caching" changes 2 file(s) — 1 code, 1 test.');
    expect(digest).toContain('- a.cs (Cache) — modified');
    expect(digest).toContain('Adds an LRU cache.');
  });

  it('falls back to the captured diff, then whatItDoes, then nothing', () => {
    const diffDigest = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ diff: 'y'.repeat(800) })],
    });
    expect(diffDigest).toContain('y'.repeat(800));
    const roleDigest = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ whatItDoes: 'Holds cache entries.' })],
    });
    expect(roleDigest).toContain('Existing role: Holds cache entries.');
    const bare = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ module: null, changeKind: null })],
    });
    expect(bare).toContain('- src/Cache.cs');
    expect(bare).not.toContain('  '); // no signal line
  });

  it('includes every changed file', () => {
    const nodes = Array.from({ length: 61 }, (_, i) => solNode({ path: `f${i}.cs` }));
    const digest = buildSolutionDigest({ title: 'PR', nodes });
    expect(digest).toContain('f60.cs');
  });

  it('retains complete solution signals', () => {
    const digest = buildSolutionDigest({
      title: 'PR',
      nodes: [solNode({ whatChanged: 'z'.repeat(500) })],
    });
    expect(digest).toContain('z'.repeat(500));
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
    });
    expect(focused).toContain('Changing this rating');
    expect(focused).toContain('do NOT change a rating on assertion');
    const whole = buildAgentChatPrompt({
      board,
      perspective: null,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(whole).not.toContain('Changing this rating');
  });

  it('omits the focus block when no perspective is selected', () => {
    const prompt = buildAgentChatPrompt({
      board,
      perspective: null,
      messages: [{ role: 'user', content: 'Summarize.' }],
    });
    expect(prompt).not.toContain('Focused perspective');
    expect(prompt).toContain('Engineering Review Agent');
  });

  it('notes when a focused perspective has no findings', () => {
    const prompt = buildAgentChatPrompt({
      board,
      perspective: { ...perspective, findings: [] },
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(prompt).toContain('none recorded yet');
  });

  it('lists a finding\'s evidence sources so the agent can cite code', () => {
    const withEvidence: ReviewPerspective = {
      ...perspective,
      findings: [
        {
          ...perspective.findings[0],
          title: 'Double materialization',
          evidence: [
            { source: 'svc/heartbeat.cs', reason: 'r', confidence: 1, direct: true },
            { source: '  ', reason: 'blank', confidence: 0.2, direct: false },
          ],
        },
      ],
    };
    const prompt = buildAgentChatPrompt({
      board,
      perspective: withEvidence,
      messages: [{ role: 'user', content: 'where?' }],
    });
    expect(prompt).toContain('Double materialization');
    // Blank sources are filtered out; only the real path is cited.
    expect(prompt).toContain('Evidence: svc/heartbeat.cs');
  });

  it('retains the latest user message beyond the former context budget', () => {
    const prompt = buildAgentChatPrompt({
      board,
      perspective: null,
      messages: [{ role: 'user', content: 'x'.repeat(30_000) + 'Final question?' }],
    });
    expect(prompt).toContain('x'.repeat(30_000) + 'Final question?');
    expect(prompt.endsWith('Assistant:')).toBe(true);
  });
});
