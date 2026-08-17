import { describe, expect, it } from 'vitest';
import {
  PR_REVIEW_BLOCK_END,
  PR_REVIEW_BLOCK_START,
  buildChangeGraphMermaid,
  buildPrReviewSection,
  upsertPrReviewBlock,
} from './pr-description-export.js';
import type {
  ChangeGraphStep,
  PrReview,
} from './pr-review-contract.js';

function graph(partial: Partial<ChangeGraphStep>): ChangeGraphStep {
  return {
    status: 'ready',
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
    projects: [],
    nodes: [],
    edges: [],
    ...partial,
  };
}

function node(path: string, projectId: string, category: 'code' | 'test' = 'code') {
  return {
    path,
    projectId,
    module: null,
    category,
    kind: 'changed' as const,
    changeKind: 'modified' as const,
    diff: '',
    whatItDoes: '',
    whatChanged: '',
    review: [],
  };
}

function review(partial: {
  content: string | null;
  sufficient: boolean;
  graph: ChangeGraphStep;
}): PrReview {
  return {
    featureId: 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'PR', url: 'https://example/pr/7' },
    worktreePath: '/wt',
    baseBranch: 'main',
    description: null,
    problemStatement: {
      status: 'ready',
      metaSessionId: null,
      usage: null,
      failure: null,
      activity: [],
      generatedAt: null,
      content: partial.content,
      sufficient: partial.sufficient,
    },
    changeGraph: partial.graph,
    changedFiles: null,
    timestamps: { createdAt: '', updatedAt: '' },
  };
}

describe('buildChangeGraphMermaid', () => {
  it('returns an empty string when the category has no nodes', () => {
    expect(buildChangeGraphMermaid(graph({}), 'code')).toBe('');
  });

  it('renders project subgraphs, nodes and labelled/plain edges', () => {
    const step = graph({
      projects: [{ id: 'p1', name: 'Alpha', path: 'Alpha.csproj' }],
      nodes: [node('src/A.cs', 'p1'), node('src/B.cs', 'p1')],
      edges: [
        { from: 'src/A.cs', to: 'src/B.cs', calls: [{ symbol: 'B', caller: 'Run' }, { symbol: 'B2', caller: null }] },
        { from: 'src/B.cs', to: 'src/A.cs', calls: [] },
      ],
    });
    const out = buildChangeGraphMermaid(step, 'code');
    expect(out).toContain('flowchart LR');
    expect(out).toContain('subgraph g0["Alpha"]');
    expect(out).toContain('n0["A.cs"]');
    expect(out).toContain('n0 -->|"B +1"| n1');
    expect(out).toContain('n1 --> n0');
  });

  it('falls back to the project id when no matching project name exists', () => {
    const step = graph({ nodes: [node('a.cs', 'missing')] });
    expect(buildChangeGraphMermaid(step, 'code')).toContain('subgraph g0["missing"]');
  });

  it('skips edges whose endpoints are not in the category', () => {
    const step = graph({
      projects: [{ id: 'p1', name: 'Alpha', path: null }],
      nodes: [node('a.cs', 'p1')],
      edges: [{ from: 'a.cs', to: 'test.cs', calls: [] }],
    });
    const out = buildChangeGraphMermaid(step, 'code');
    expect(out).not.toContain('-->');
  });

  it('labels a single-call edge without an overflow suffix', () => {
    const step = graph({
      projects: [{ id: 'p1', name: 'Alpha', path: null }],
      nodes: [node('src/A.cs', 'p1'), node('src/B.cs', 'p1')],
      edges: [
        { from: 'src/A.cs', to: 'src/B.cs', calls: [{ symbol: 'B', caller: 'Run' }] },
      ],
    });
    const out = buildChangeGraphMermaid(step, 'code');
    expect(out).toContain('n0 -->|"B"| n1');
    expect(out).not.toContain('+');
  });

  it('falls back to the raw path when a node path has no segments', () => {
    const step = graph({
      projects: [{ id: 'p1', name: 'Alpha', path: null }],
      nodes: [node('/', 'p1')],
    });
    const out = buildChangeGraphMermaid(step, 'code');
    expect(out).toContain('n0["/"]');
  });
});

describe('buildPrReviewSection', () => {
  it('includes the problem statement and the change graph diagram', () => {
    const step = graph({
      projects: [{ id: 'p1', name: 'Alpha', path: null }],
      nodes: [node('a.cs', 'p1')],
    });
    const section = buildPrReviewSection(
      review({ content: 'Fixes the bug.', sufficient: true, graph: step }),
    );
    expect(section).toContain('### Problem statement');
    expect(section).toContain('Fixes the bug.');
    expect(section).toContain('```mermaid');
  });

  it('shows a placeholder when the problem statement is insufficient and omits an empty graph', () => {
    const section = buildPrReviewSection(
      review({ content: null, sufficient: false, graph: graph({}) }),
    );
    expect(section).toContain('did not contain enough detail');
    expect(section).not.toContain('```mermaid');
  });
});

describe('upsertPrReviewBlock', () => {
  it('creates the block when the body is empty', () => {
    const out = upsertPrReviewBlock('', 'SECTION');
    expect(out).toBe(`${PR_REVIEW_BLOCK_START}\nSECTION\n${PR_REVIEW_BLOCK_END}`);
  });

  it('appends the block after existing content', () => {
    const out = upsertPrReviewBlock('Author text', 'SECTION');
    expect(out.startsWith('Author text')).toBe(true);
    expect(out).toContain(PR_REVIEW_BLOCK_START);
  });

  it('replaces an existing block in place', () => {
    const body = `Top\n${PR_REVIEW_BLOCK_START}\nOLD\n${PR_REVIEW_BLOCK_END}\nBottom`;
    const out = upsertPrReviewBlock(body, 'NEW');
    expect(out).toContain('NEW');
    expect(out).not.toContain('OLD');
    expect(out).toContain('Top');
    expect(out).toContain('Bottom');
  });
});
