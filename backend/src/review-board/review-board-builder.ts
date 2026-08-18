/**
 * Assembles a `ReviewBoard` from a change's derived project model plus a small
 * set of *deterministic, evidence-backed* findings. Increment one keeps findings
 * to signals that can be computed with certainty from the change graph (missing
 * tests, missing description, config churn, blast-radius breadth); richer
 * AI-authored per-perspective findings are a later increment. Everything here is
 * pure so it can be exhaustively unit-tested against the 100% coverage gate.
 */

import type { DiscoveryInput, ProjectModel } from './review-board-contract.js';
import type {
  ReviewBoard,
  ReviewBoardPull,
  ReviewBoardSummary,
  ReviewEvidence,
  ReviewFinding,
  ReviewPerspective,
  ReviewRecommendation,
  ReviewRisk,
  ReviewStatus,
} from './review-board-contract.js';

/** Tunable thresholds the board uses to band findings (owned by config). */
export interface BoardThresholds {
  /** A description shorter than this (trimmed) is flagged as minimal. */
  minDescriptionChars: number;
  /** Blast-radius breadth at/above this is at least medium risk. */
  blastRadiusMediumThreshold: number;
  /** Blast-radius breadth at/above this is high risk. */
  blastRadiusHighThreshold: number;
}

/** Inputs to board assembly beyond the discovered model. */
export interface BuildBoardInput {
  featureId: string;
  pull: ReviewBoardPull;
  worktreePath: string;
  baseBranch: string | null;
  description: DiscoveryInput['description'];
  nodes: DiscoveryInput['nodes'];
  changedFiles: number;
  model: ProjectModel;
  thresholds: BoardThresholds;
  generatedAt: string;
}

/** Band a count into a coarse risk level. */
function bandRisk(count: number, medium: number, high: number): ReviewRisk {
  if (count >= high) return 'high';
  if (count >= medium) return 'medium';
  return 'low';
}

/** Rolled-up worst status across a perspective's findings. */
function statusFromFindings(findings: ReviewFinding[]): ReviewStatus {
  if (findings.some((f) => f.status === 'blocked')) return 'blocked';
  if (findings.some((f) => f.status === 'warning')) return 'warning';
  return 'needs-review';
}

/**
 * Build the deterministic findings for every perspective. Only perspectives
 * with a certain, evidence-backed signal receive a finding in increment one.
 */
function buildFindings(input: BuildBoardInput): ReviewFinding[] {
  const { model, nodes } = input;
  const { minDescriptionChars, blastRadiusMediumThreshold, blastRadiusHighThreshold } =
    input.thresholds;
  const findings: ReviewFinding[] = [];
  const changed = nodes.filter((n) => n.kind === 'changed');
  const changedCode = changed.filter((n) => n.category === 'code');
  const changedTests = changed.filter((n) => n.category === 'test');

  // Problem ↔ Solution: description quality.
  const description = (input.description ?? '').trim();
  if (description.length < minDescriptionChars) {
    findings.push({
      id: 'problem-solution/missing-description',
      perspectiveId: 'problem-solution',
      title: 'PR description is missing or minimal',
      detail:
        'The change lacks a substantive description, making it hard to confirm the implementation matches the intended problem.',
      severity: 'medium',
      status: 'warning',
      evidence: [
        {
          source: 'pull request description',
          reason: `Description is ${description.length} character(s) long.`,
          confidence: 0.9,
          direct: true,
        },
      ],
    });
  }

  // Testing: code changed without accompanying test changes.
  if (changedCode.length > 0 && changedTests.length === 0) {
    findings.push({
      id: 'testing/no-tests-changed',
      perspectiveId: 'testing',
      title: 'No test files changed',
      detail: `${changedCode.length} code file(s) changed but no test files were touched. Confirm the change is covered.`,
      severity: 'medium',
      status: 'warning',
      evidence: [
        {
          source: 'change graph',
          reason: `${changedCode.length} code node(s) changed, 0 test node(s) changed.`,
          confidence: 0.85,
          direct: true,
        },
      ],
    });
  }

  // Configuration: any config churn is worth a deliberate look.
  if (model.configurationSystems.length > 0) {
    const names = model.configurationSystems.map((c) => c.name).join(', ');
    findings.push({
      id: 'configuration/config-changed',
      perspectiveId: 'configuration',
      title: 'Configuration files changed',
      detail: `Verify safe defaults and rollback for changed configuration (${names}).`,
      severity: 'suggestion',
      status: 'needs-review',
      evidence: model.configurationSystems.flatMap((c) => c.evidence),
    });
  }

  // Impact & Blast Radius: breadth of what the change reaches.
  const breadth =
    model.changedComponents.length +
    model.configurationSystems.length +
    model.changedRuntimePaths.length;
  const blastEvidence: ReviewEvidence[] = [
    {
      source: 'change graph',
      reason: `${model.changedComponents.length} component(s), ${model.configurationSystems.length} config system(s), ${model.changedRuntimePaths.length} runtime area(s) touched.`,
      confidence: 0.7,
      direct: true,
    },
  ];
  const blastRisk = bandRisk(breadth, blastRadiusMediumThreshold, blastRadiusHighThreshold);
  if (blastRisk !== 'low') {
    findings.push({
      id: 'impact-blast-radius/breadth',
      perspectiveId: 'impact-blast-radius',
      title: `${blastRisk === 'high' ? 'Wide' : 'Moderate'} blast radius`,
      detail: `The change spans ${model.blastRadiusDimensions.join(', ')}. Review each dimension before approving.`,
      severity: blastRisk === 'high' ? 'high' : 'medium',
      status: blastRisk === 'high' ? 'blocked' : 'warning',
      evidence: blastEvidence,
    });
  }

  return findings;
}

/** Per-perspective risk overrides derived from the model. */
function riskForPerspective(
  id: string,
  model: ProjectModel,
  findings: ReviewFinding[],
  thresholds: BoardThresholds,
): ReviewRisk {
  const own = findings.filter((f) => f.perspectiveId === id);
  if (own.some((f) => f.severity === 'critical' || f.severity === 'high')) {
    return 'high';
  }
  if (own.some((f) => f.severity === 'medium')) return 'medium';
  if (id === 'impact-blast-radius') {
    const breadth =
      model.changedComponents.length +
      model.configurationSystems.length +
      model.changedRuntimePaths.length;
    return bandRisk(
      breadth,
      thresholds.blastRadiusMediumThreshold,
      thresholds.blastRadiusHighThreshold,
    );
  }
  if (own.length > 0) return 'low';
  return 'unknown';
}

/** Compute the header roll-up counts from all findings. */
function summarize(findings: ReviewFinding[]): ReviewBoardSummary {
  let blocking = 0;
  let warnings = 0;
  let suggestions = 0;
  for (const f of findings) {
    if (f.severity === 'critical' || f.severity === 'high') blocking += 1;
    else if (f.severity === 'suggestion') suggestions += 1;
    else warnings += 1;
  }
  return { open: findings.length, blocking, warnings, suggestions };
}

/** Merge recommendation; never auto-approves. */
function recommend(summary: ReviewBoardSummary): ReviewRecommendation {
  if (summary.blocking > 0) return 'request-changes';
  return 'needs-review';
}

/** Assemble the full board. */
export function buildReviewBoard(input: BuildBoardInput): ReviewBoard {
  const findings = buildFindings(input);
  const perspectives: ReviewPerspective[] = input.model.perspectives.map(
    (spec) => {
      const own = findings.filter((f) => f.perspectiveId === spec.id);
      return {
        id: spec.id,
        name: spec.name,
        why: spec.why,
        source: spec.source,
        status: statusFromFindings(own),
        risk: riskForPerspective(spec.id, input.model, findings, input.thresholds),
        findings: own,
      };
    },
  );
  const summary = summarize(findings);

  return {
    featureId: input.featureId,
    pull: input.pull,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    changedFiles: input.changedFiles,
    model: input.model,
    perspectives,
    recommendation: recommend(summary),
    summary,
    generatedAt: input.generatedAt,
  };
}
