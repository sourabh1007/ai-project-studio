import { describe, expect, it } from 'vitest';
import {
  buildPerspectiveEvidenceFloor,
  buildProblemSolutionFloor,
  buildSolutionSummary,
} from './review-board-evidence.js';
import type {
  ProjectModel,
  ReviewFinding,
  ReviewPerspective,
} from './review-board-contract.js';

const model: ProjectModel = {
  projectType: 'Backend service',
  projectTypeConfidence: 0.8,
  primaryLanguages: ['C#'],
  secondaryLanguages: [],
  changedComponents: ['Cache', 'Config'],
  changedModules: [],
  changedRuntimePaths: [],
  configurationSystems: [],
  testSignals: [],
  deploymentModel: '',
  contracts: [],
  blastRadiusDimensions: ['Components', 'Consumers'],
  perspectives: [],
  confidence: 0.6,
  evidence: [],
};

function finding(title: string): ReviewFinding {
  return {
    id: `id-${title}`,
    perspectiveId: 'p',
    title,
    detail: 'd',
    severity: 'high',
    status: 'blocked',
    evidence: [],
  };
}

function perspective(
  findings: ReviewFinding[],
  overrides: Partial<ReviewPerspective> = {},
): ReviewPerspective {
  return {
    id: 'problem-solution',
    name: 'Problem ↔ Solution',
    why: 'Every change must be checked against the problem it claims to solve.',
    source: 'core',
    status: 'approved',
    risk: 'low',
    findings,
    ...overrides,
  };
}

describe('buildPerspectiveEvidenceFloor', () => {
  it('documents a clean verdict grounded in the changed files', () => {
    const floor = buildPerspectiveEvidenceFloor({
      perspective: perspective([]),
      changedPaths: ['src/Cache.cs', 'src/Config.cs'],
      model,
    });
    expect(floor.summary).toContain('2 changed files');
    expect(floor.summary).toContain('Problem ↔ Solution');
    expect(floor.summary).toContain('Components, Consumers');
    expect(floor.summary).toContain('approved / low');
    expect(floor.rationale.map((r) => r.label)).toEqual([
      'Concern',
      'What changed',
      'Assessment',
      'Verdict',
    ]);
    expect(floor.rationale[1].detail).toContain('src/Cache.cs, src/Config.cs');
    expect(floor.rationale[1].detail).toContain('in Cache, Config');
    // One pass-check per changed file for a clean lens.
    expect(floor.checks).toHaveLength(2);
    expect(floor.checks[0]).toEqual({
      item: 'src/Cache.cs',
      finding: 'Inspected against "Problem ↔ Solution" — no concern found.',
      status: 'pass',
    });
  });

  it('uses singular wording for a single changed file', () => {
    const floor = buildPerspectiveEvidenceFloor({
      perspective: perspective([]),
      changedPaths: ['only.cs'],
      model,
    });
    expect(floor.summary).toContain('1 changed file ');
    expect(floor.summary).not.toContain('1 changed files');
  });

  it('summarises findings and marks each file a concern when issues exist', () => {
    const floor = buildPerspectiveEvidenceFloor({
      perspective: perspective([finding('Missing validation')], {
        status: 'blocked',
        risk: 'high',
      }),
      changedPaths: ['src/Cache.cs'],
      model,
    });
    expect(floor.summary).toContain('1 issue was surfaced');
    expect(floor.summary).toContain('blocked / high');
    expect(floor.rationale[2].detail).toContain('Missing validation');
    expect(floor.checks[0].status).toBe('concern');
  });

  it('pluralises the issue count for multiple findings', () => {
    const floor = buildPerspectiveEvidenceFloor({
      perspective: perspective([finding('A'), finding('B')]),
      changedPaths: ['a.cs'],
      model,
    });
    expect(floor.summary).toContain('2 issues were surfaced');
  });

  it('caps enumerated checks and records an overflow entry', () => {
    const paths = Array.from({ length: 11 }, (_, i) => `f${i}.cs`);
    const floor = buildPerspectiveEvidenceFloor({
      perspective: perspective([]),
      changedPaths: paths,
      model,
    });
    // 8 enumerated + 1 overflow summary row.
    expect(floor.checks).toHaveLength(9);
    expect(floor.checks[8]).toEqual({
      item: '+3 more changed file(s)',
      finding: 'Inspected as part of the same lens review.',
      status: 'pass',
    });
    expect(floor.rationale[1].detail).toContain('+3 more');
  });

  it('overflow row is a concern when findings exist', () => {
    const paths = Array.from({ length: 9 }, (_, i) => `f${i}.cs`);
    const floor = buildPerspectiveEvidenceFloor({
      perspective: perspective([finding('X')]),
      changedPaths: paths,
      model,
    });
    expect(floor.checks[floor.checks.length - 1].status).toBe('concern');
  });

  it('falls back to description/model when no changed files resolve', () => {
    const floor = buildPerspectiveEvidenceFloor({
      perspective: perspective([]),
      changedPaths: [],
      model: { ...model, blastRadiusDimensions: [], changedComponents: [] },
    });
    expect(floor.summary).toContain('the changed surface');
    expect(floor.rationale[1].detail).toContain('No changed files were resolved');
    expect(floor.checks).toHaveLength(1);
    expect(floor.checks[0].status).toBe('na');
  });
});

describe('buildProblemSolutionFloor', () => {
  it('frames a clean verdict as an aligned problem/solution narrative', () => {
    const floor = buildProblemSolutionFloor({
      perspective: perspective([]),
      problemStatement: 'Users cannot cache reads, so latency is high.',
      problemSufficient: true,
      solutionSummary: 'The change spans 2 file(s) (2 code, 0 test) across Cache.',
    });
    expect(floor.rationale.map((r) => r.label)).toEqual([
      'Problem',
      'Solution implemented',
      'Why they align',
      'Verdict',
    ]);
    expect(floor.rationale[0].detail).toBe(
      'Users cannot cache reads, so latency is high.',
    );
    expect(floor.rationale[2].detail).toContain('align');
    expect(floor.summary).toContain('Problem:');
    expect(floor.summary).toContain('approved / low');
    // No file-level line-by-line audit for this lens.
    expect(floor.checks).toEqual([]);
  });

  it('records gaps and a non-aligned narrative when findings exist', () => {
    const floor = buildProblemSolutionFloor({
      perspective: perspective([finding('Retry path unaddressed')], {
        status: 'needs-review',
        risk: 'medium',
      }),
      problemStatement: 'p',
      problemSufficient: true,
      solutionSummary: 'The change spans 1 file(s) (1 code, 0 test).',
    });
    expect(floor.rationale[2].detail).toContain('does not fully solve');
    expect(floor.rationale[2].detail).toContain('Retry path unaddressed');
    expect(floor.summary).toContain('do not fully align');
    expect(floor.summary).toContain('needs-review / medium');
  });

  it('pluralises multiple gaps', () => {
    const floor = buildProblemSolutionFloor({
      perspective: perspective([finding('A'), finding('B')]),
      problemStatement: 'p',
      problemSufficient: true,
      solutionSummary: 's',
    });
    expect(floor.rationale[2].detail).toContain('2 gaps were');
  });

  it('notes when no self-contained problem statement was distilled', () => {
    const floor = buildProblemSolutionFloor({
      perspective: perspective([]),
      problemStatement: null,
      problemSufficient: false,
      solutionSummary: 's',
    });
    expect(floor.rationale[0].detail).toContain(
      'did not carry a self-contained problem statement',
    );
  });

  it('treats an insufficient problem statement as missing', () => {
    const floor = buildProblemSolutionFloor({
      perspective: perspective([]),
      problemStatement: 'some text',
      problemSufficient: false,
      solutionSummary: 's',
    });
    expect(floor.rationale[0].detail).toContain(
      'did not carry a self-contained problem statement',
    );
  });
});

describe('buildSolutionSummary', () => {
  it('notes when nothing changed', () => {
    expect(
      buildSolutionSummary({ changedCount: 0, codeCount: 0, components: [] }),
    ).toContain('No changed files were resolved');
  });

  it('splits code/test and lists touched components', () => {
    expect(
      buildSolutionSummary({
        changedCount: 3,
        codeCount: 2,
        components: ['Cache', 'Config'],
      }),
    ).toBe('The change spans 3 file(s) (2 code, 1 test) across Cache, Config.');
  });

  it('omits the component clause when none are known', () => {
    expect(
      buildSolutionSummary({ changedCount: 1, codeCount: 1, components: [] }),
    ).toBe('The change spans 1 file(s) (1 code, 0 test).');
  });

  it('caps the component list at six with an overflow marker', () => {
    const components = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(
      buildSolutionSummary({ changedCount: 8, codeCount: 8, components }),
    ).toContain('across a, b, c, d, e, f, +2 more.');
  });
});
