import { describe, expect, it } from 'vitest';
import { buildEmptyBoard, buildReviewBoard } from './review-board-builder.js';
import type { BoardThresholds, BuildBoardInput } from './review-board-builder.js';
import type {
  DiscoveryNode,
  PerspectiveSpec,
  ProjectModel,
} from './review-board-contract.js';

const thresholds: BoardThresholds = {
  minDescriptionChars: 30,
  blastRadiusMediumThreshold: 3,
  blastRadiusHighThreshold: 6,
};

const perspectiveIds = [
  'problem-solution',
  'testing',
  'configuration',
  'impact-blast-radius',
  'security',
];

function specs(): PerspectiveSpec[] {
  return perspectiveIds.map((id) => ({
    id,
    name: id,
    why: 'because',
    source: 'core' as const,
  }));
}

function model(over: Partial<ProjectModel> = {}): ProjectModel {
  return {
    projectType: 'Backend service',
    projectTypeConfidence: 0.8,
    primaryLanguages: ['Go'],
    secondaryLanguages: [],
    changedComponents: [],
    changedModules: [],
    changedRuntimePaths: [],
    configurationSystems: [],
    testSignals: [],
    deploymentModel: '',
    contracts: [],
    blastRadiusDimensions: ['Consumers'],
    perspectives: specs(),
    confidence: 0.7,
    evidence: [],
    ...over,
  };
}

function node(over: Partial<DiscoveryNode> & { path: string }): DiscoveryNode {
  return { category: 'code', kind: 'changed', module: null, ...over };
}

function build(over: Partial<BuildBoardInput>) {
  return buildReviewBoard({
    featureId: 'f1',
    pull: { number: 1, title: 't', url: 'u', headSha: null },
    worktreePath: 'w',
    baseBranch: 'main',
    description: 'A sufficiently long description of the change here.',
    nodes: [],
    changedFiles: 0,
    model: model(),
    thresholds,
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
}

describe('buildEmptyBoard', () => {
  const emptyInput: BuildBoardInput = {
    featureId: 'f1',
    pull: { number: 7, title: 't', url: 'u', headSha: null },
    worktreePath: 'w',
    baseBranch: 'main',
    description: 'short',
    nodes: [node({ path: 'a.go', category: 'code' })],
    changedFiles: 5,
    model: model({ changedComponents: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
    thresholds,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('starts every perspective clean regardless of deterministic signals', () => {
    const board = buildEmptyBoard(emptyInput);
    expect(board.summary).toEqual({
      open: 0,
      blocking: 0,
      warnings: 0,
      suggestions: 0,
    });
    expect(board.recommendation).toBe('needs-review');
    expect(board.changedFiles).toBe(5);
    for (const p of board.perspectives) {
      expect(p.findings).toHaveLength(0);
      expect(p.status).toBe('not-started');
      expect(p.risk).toBe('unknown');
    }
  });

  it('preserves the pull, model and generatedAt metadata', () => {
    const board = buildEmptyBoard(emptyInput);
    expect(board.pull.number).toBe(7);
    expect(board.model.projectType).toBe('Backend service');
    expect(board.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('buildReviewBoard findings', () => {
  it('flags a missing description', () => {
    const board = build({ description: 'short' });
    const f = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(f?.findings.some((x) => x.id.includes('missing-description'))).toBe(true);
    expect(f?.status).toBe('warning');
  });

  it('treats a null description as missing', () => {
    const board = build({ description: null });
    const f = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(f?.findings.some((x) => x.id.includes('missing-description'))).toBe(true);
  });

  it('does not flag a sufficient description', () => {
    const board = build({ description: 'x'.repeat(40) });
    const f = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(f?.findings).toHaveLength(0);
    expect(f?.status).toBe('needs-review');
  });

  it('flags code changed without tests, and clears when tests present', () => {
    const withoutTests = build({
      nodes: [node({ path: 'a.go', category: 'code' })],
    });
    expect(
      withoutTests.perspectives
        .find((p) => p.id === 'testing')
        ?.findings.some((x) => x.id.includes('no-tests-changed')),
    ).toBe(true);

    const withTests = build({
      nodes: [
        node({ path: 'a.go', category: 'code' }),
        node({ path: 'a_test.go', category: 'test' }),
      ],
    });
    expect(
      withTests.perspectives.find((p) => p.id === 'testing')?.findings,
    ).toHaveLength(0);
  });

  it('flags configuration churn as a suggestion (low risk)', () => {
    const board = build({
      model: model({
        configurationSystems: [
          {
            name: 'JSON configuration',
            evidence: [
              { source: 'a.json', reason: 'json', confidence: 0.8, direct: true },
            ],
          },
        ],
      }),
    });
    const cfg = board.perspectives.find((p) => p.id === 'configuration');
    expect(cfg?.findings[0].severity).toBe('suggestion');
    expect(cfg?.risk).toBe('low');
    expect(board.summary.suggestions).toBe(1);
  });
});

describe('buildReviewBoard blast radius banding', () => {
  it('produces no blast finding for a narrow change (low risk band via id)', () => {
    const board = build({
      model: model({ changedComponents: ['One'] }),
    });
    const impact = board.perspectives.find((p) => p.id === 'impact-blast-radius');
    expect(impact?.findings).toHaveLength(0);
    expect(impact?.risk).toBe('low');
  });

  it('produces a medium (warning) blast finding', () => {
    const board = build({
      model: model({
        changedComponents: ['A', 'B', 'C'],
        blastRadiusDimensions: ['Components', 'Consumers'],
      }),
    });
    const impact = board.perspectives.find((p) => p.id === 'impact-blast-radius');
    expect(impact?.risk).toBe('medium');
    expect(impact?.status).toBe('warning');
    expect(board.recommendation).toBe('needs-review');
  });

  it('produces a high (blocking) blast finding and requests changes', () => {
    const board = build({
      model: model({
        changedComponents: ['A', 'B', 'C', 'D', 'E', 'F'],
        blastRadiusDimensions: ['Components', 'Consumers'],
      }),
    });
    const impact = board.perspectives.find((p) => p.id === 'impact-blast-radius');
    expect(impact?.risk).toBe('high');
    expect(impact?.status).toBe('blocked');
    expect(board.summary.blocking).toBe(1);
    expect(board.recommendation).toBe('request-changes');
  });
});

describe('buildReviewBoard risk and status roll-ups', () => {
  it('reports unknown risk for a perspective with no findings', () => {
    const board = build({ description: 'x'.repeat(40) });
    const security = board.perspectives.find((p) => p.id === 'security');
    expect(security?.risk).toBe('unknown');
    expect(security?.status).toBe('needs-review');
  });

  it('reports medium risk from a medium finding (testing)', () => {
    const board = build({
      nodes: [node({ path: 'a.go', category: 'code' })],
    });
    const testing = board.perspectives.find((p) => p.id === 'testing');
    expect(testing?.risk).toBe('medium');
  });

  it('echoes board metadata', () => {
    const board = build({});
    expect(board.featureId).toBe('f1');
    expect(board.pull.number).toBe(1);
    expect(board.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(board.summary.open).toBe(0);
  });
});
