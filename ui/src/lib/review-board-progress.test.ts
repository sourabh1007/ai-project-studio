import { describe, expect, it } from 'vitest';
import {
  mapWithConcurrency,
  mergeAnalyzedPerspective,
  recommendationFor,
  summarizePerspectives,
} from './review-board-progress.js';
import type { ReviewBoard, ReviewFinding, ReviewPerspective } from './types.js';

function finding(severity: ReviewFinding['severity']): ReviewFinding {
  return {
    id: `id-${severity}-${Math.random()}`,
    perspectiveId: 'p',
    title: 't',
    detail: 'd',
    severity,
    status: 'needs-review',
    evidence: [],
  };
}

function perspective(
  id: string,
  findings: ReviewFinding[],
): ReviewPerspective {
  return {
    id,
    name: id,
    why: 'w',
    source: 'core',
    status: 'needs-review',
    risk: 'low',
    findings,
  };
}

describe('summarizePerspectives', () => {
  it('counts findings by severity bucket', () => {
    const summary = summarizePerspectives([
      perspective('a', [finding('critical'), finding('high')]),
      perspective('b', [finding('medium'), finding('low')]),
      perspective('c', [finding('suggestion')]),
    ]);
    expect(summary).toEqual({
      open: 5,
      blocking: 2,
      warnings: 2,
      suggestions: 1,
    });
  });

  it('returns zeros for an empty board', () => {
    expect(summarizePerspectives([])).toEqual({
      open: 0,
      blocking: 0,
      warnings: 0,
      suggestions: 0,
    });
  });
});

describe('recommendationFor', () => {
  it('requests changes when there is blocking work', () => {
    expect(
      recommendationFor({ open: 1, blocking: 1, warnings: 0, suggestions: 0 }),
    ).toBe('request-changes');
  });

  it('needs review otherwise', () => {
    expect(
      recommendationFor({ open: 2, blocking: 0, warnings: 2, suggestions: 0 }),
    ).toBe('needs-review');
  });
});

describe('mergeAnalyzedPerspective', () => {
  const board: ReviewBoard = {
    featureId: 'f',
    pull: { number: 1, title: 't', url: 'u' },
    worktreePath: 'w',
    baseBranch: 'main',
    changedFiles: 1,
    model: {
      projectType: 'x',
      projectTypeConfidence: 1,
      primaryLanguages: [],
      secondaryLanguages: [],
      changedComponents: [],
      changedModules: [],
      changedRuntimePaths: [],
      configurationSystems: [],
      testSignals: [],
      deploymentModel: '',
      contracts: [],
      blastRadiusDimensions: [],
      confidence: 1,
      evidence: [],
    },
    perspectives: [perspective('a', []), perspective('b', [])],
    recommendation: 'needs-review',
    summary: { open: 0, blocking: 0, warnings: 0, suggestions: 0 },
    generatedAt: 't',
  };

  it('replaces the perspective and recomputes summary + recommendation', () => {
    const next = mergeAnalyzedPerspective(
      board,
      perspective('a', [finding('high')]),
    );
    expect(next.perspectives[0].findings).toHaveLength(1);
    expect(next.perspectives[1]).toBe(board.perspectives[1]);
    expect(next.summary.blocking).toBe(1);
    expect(next.recommendation).toBe('request-changes');
  });
});

describe('mapWithConcurrency', () => {
  it('processes every item', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('caps workers to the item count', async () => {
    const seen: string[] = [];
    await mapWithConcurrency(['only'], 8, async (s) => {
      seen.push(s);
    });
    expect(seen).toEqual(['only']);
  });
});
