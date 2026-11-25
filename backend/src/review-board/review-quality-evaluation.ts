import { ProviderError } from '../kernel/error-types.js';
import type { PerspectiveAnalysis, ReviewEvidence, ReviewFinding } from './review-board-contract.js';
import type { ReviewRequirement } from './review-run-contract.js';
import { groupReviewFindings } from './review-run.js';

export const REVIEW_QUALITY_EVALUATION_LABEL =
  'Deterministic labelled synthetic captured-output replay; NOT a live vendor/model benchmark';

export interface ReviewQualityCapture {
  analyses: Record<string, PerspectiveAnalysis>;
  /** Human-authored ground-truth labels, never model-produced scoring labels. */
  labels: Record<string, string | null>;
  duplicatePairs: Array<{ findingIds: [string, string]; sameIssue: boolean }>;
}

export interface ReviewQualityFixture {
  id: string;
  description: string;
  capturedFiles: Array<{ path: string; lines: number[] }>;
  requirements: ReviewRequirement[];
  skillIds: string[];
  issues: Array<{ id: string; blocker: boolean; source: string; skillIds: string[]; requirementIds: string[] }>;
  baseline: ReviewQualityCapture;
  enriched: ReviewQualityCapture;
}

export interface ReviewQualityMetrics {
  findingCount: number;
  invalidEvidence: number;
  evidenceValidity: number | null;
  seededBlockerRecall: number | null;
  falsePositives: number;
  missedBlockers: string[];
  duplicateDistinction: number | null;
  attributionCorrectness: number | null;
  insufficientBusinessContextCorrect: boolean | null;
  falsePolicyPasses: number;
}

export interface ReviewQualityEvaluation {
  label: typeof REVIEW_QUALITY_EVALUATION_LABEL;
  fixtureId: string;
  baseline: ReviewQualityMetrics;
  enriched: ReviewQualityMetrics;
}

function validEvidence(entry: ReviewEvidence, fixture: ReviewQualityFixture): boolean {
  const file = fixture.capturedFiles.find((candidate) => candidate.path === entry.source);
  return !!file && entry.reason.trim().length > 0
    && Number.isFinite(entry.confidence) && entry.confidence > 0 && entry.confidence <= 1
    && (!entry.location || (entry.location.path === file.path
      && (entry.location.side === 'RIGHT' || entry.location.side === 'LEFT')
      && file.lines.includes(entry.location.line)));
}

function scoreCapture(fixture: ReviewQualityFixture, capture: ReviewQualityCapture): ReviewQualityMetrics {
  const analyses = Object.keys(capture.analyses).sort().map((key) => capture.analyses[key]!);
  const findings = analyses.flatMap((analysis) => analysis.perspective.findings);
  const groups = groupReviewFindings(findings);
  const groupFor = new Map(groups.flatMap((group) => group.observations.map((observation) => [observation.id, group.id] as const)));
  const correctIssues = new Set<string>();
  const falseGroups = new Set<string>();
  let invalidEvidence = 0;
  let correctAttributions = 0;
  const equivalent = (left: string[], right: string[]) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  for (const finding of findings) {
    const evidenced = finding.evidence.length > 0 && finding.evidence.every((entry) => validEvidence(entry, fixture));
    if (!evidenced) invalidEvidence++;
    const issue = fixture.issues.find((candidate) => candidate.id === capture.labels[finding.id]);
    if (issue && evidenced && finding.evidence.some((entry) => entry.source === issue.source)) correctIssues.add(issue.id);
    else falseGroups.add(groupFor.get(finding.id)!);
    const skills = finding.skillIds ?? [];
    const requirements = finding.requirementIds ?? [];
    if (issue && skills.every((id) => fixture.skillIds.includes(id)) && requirements.every((id) => fixture.requirements.some((requirement) => requirement.id === id))
      && equivalent(skills, issue.skillIds) && equivalent(requirements, issue.requirementIds)) correctAttributions++;
  }
  const pairs = capture.duplicatePairs.filter((pair) => pair.findingIds.every((id) => groupFor.has(id)));
  const correctPairs = pairs.filter((pair) => (groupFor.get(pair.findingIds[0]) === groupFor.get(pair.findingIds[1])) === pair.sameIssue).length;
  const blockers = fixture.issues.filter((issue) => issue.blocker);
  const missedBlockers = blockers.filter((issue) => !correctIssues.has(issue.id)).map((issue) => issue.id).sort();
  const business = analyses.filter((analysis) => analysis.perspectiveId === 'business');
  const missingPolicy = !fixture.requirements.some((requirement) => requirement.priority < 100);
  const insufficientBusinessContextCorrect = missingPolicy
    ? business.length > 0 && business.every((analysis) => analysis.assessment === 'insufficient-evidence' && !analysis.skipped
      && analysis.perspective.status !== 'approved')
    : null;
  const unsupportedRequirements = analyses.flatMap((analysis) => analysis.requirements ?? []).filter((entry) =>
    (entry.assessment === 'supported' || entry.assessment === 'violated')
    && (!fixture.requirements.some((requirement) => requirement.id === entry.requirementId)
      || !entry.evidence.length || !entry.evidence.every((evidence) => validEvidence(evidence, fixture)))).length;
  const falsePolicyPasses = unsupportedRequirements + business.filter((analysis) => missingPolicy
    && (analysis.assessment === 'no-concerns' || analysis.perspective.status === 'approved')).length;
  return {
    findingCount: findings.length, invalidEvidence,
    evidenceValidity: findings.length ? (findings.length - invalidEvidence) / findings.length : null,
    seededBlockerRecall: blockers.length ? (blockers.length - missedBlockers.length) / blockers.length : null,
    falsePositives: falseGroups.size, missedBlockers,
    duplicateDistinction: pairs.length ? correctPairs / pairs.length : null,
    attributionCorrectness: findings.length ? correctAttributions / findings.length : null,
    insufficientBusinessContextCorrect, falsePolicyPasses,
  };
}

export function evaluateReviewQualityFixture(fixture: ReviewQualityFixture): ReviewQualityEvaluation {
  return { label: REVIEW_QUALITY_EVALUATION_LABEL, fixtureId: fixture.id,
    baseline: scoreCapture(fixture, fixture.baseline), enriched: scoreCapture(fixture, fixture.enriched) };
}

/** CI gates apply to labelled replays only; they make no vendor-quality claim. */
export function assertReviewQualityGates(metrics: ReviewQualityMetrics): void {
  if (metrics.invalidEvidence || metrics.falsePolicyPasses || metrics.falsePositives || metrics.missedBlockers.length
    || metrics.duplicateDistinction === 0 || (metrics.duplicateDistinction !== null && metrics.duplicateDistinction < 1)
    || (metrics.attributionCorrectness !== null && metrics.attributionCorrectness < 1)
    || metrics.insufficientBusinessContextCorrect === false) {
    throw new ProviderError('Labelled review replay quality gate failed (not a live model benchmark)', metrics);
  }
}

function capturedAnalysis(id: string, findings: ReviewFinding[], assessment: PerspectiveAnalysis['assessment'] = 'concerns'): PerspectiveAnalysis {
  return { perspectiveId: id, perspective: { id, name: id, why: 'Labelled replay concern', source: 'core',
    status: assessment === 'insufficient-evidence' ? 'needs-review' : 'blocked', risk: 'unknown', findings },
    assessment, skipped: false, skipReason: null, summary: 'Synthetic captured output', rationale: [], checks: [] };
}

function capturedFinding(id: string, perspectiveId: string, kind: 'write' | 'quota'): ReviewFinding {
  const quota = kind === 'quota';
  return { id, perspectiveId, title: quota ? 'Quota bypass' : 'Pending write lost on retry',
    detail: quota ? 'The quota guard is skipped' : 'The retry drops the pending write before commit',
    severity: 'high', status: 'blocked', skillIds: [quota ? 'studio:business' : 'repository:persistence'],
    requirementIds: quota ? ['requirement:fixture:quota'] : [],
    evidence: [{ source: quota ? 'src/quota.ts' : 'src/cache.ts', reason: quota ? 'Guard removed at the write boundary' : 'Pending write discarded on retry',
      confidence: 1, direct: true, location: { path: quota ? 'src/quota.ts' : 'src/cache.ts', line: quota ? 12 : 5, side: 'RIGHT' } }] };
}

export function createReviewQualityReplayFixtures(): ReviewQualityFixture[] {
  const write = capturedFinding('enriched/write-security', 'security', 'write');
  const repeated = capturedFinding('enriched/write-integrity', 'integrity', 'write');
  const quota = capturedFinding('enriched/quota-business', 'business', 'quota');
  const baselineWrite = { ...write, id: 'baseline/write-security', skillIds: [] };
  const baselineRepeat = { ...repeated, id: 'baseline/write-integrity', detail: 'Retry loses the queued write', skillIds: [] };
  const falsePositive = { ...write, id: 'baseline/style', title: 'Style preference', detail: 'Prefer a different local name', skillIds: [] };
  const missing = capturedAnalysis('business', [], 'insufficient-evidence');
  const falsePass = capturedAnalysis('business', [], 'no-concerns');
  falsePass.perspective.status = 'approved';
  return [
    {
      id: 'seeded-blockers-duplicates-attribution',
      description: 'Synthetic labelled outputs compare missed blockers, false positives, duplicate distinction and exact provenance.',
      capturedFiles: [{ path: 'src/cache.ts', lines: [5, 8] }, { path: 'src/quota.ts', lines: [12] }],
      requirements: [{ id: 'requirement:fixture:quota', text: 'Writes must enforce the configured quota.',
        source: 'review-options:business-context', fingerprint: 'fixture-only', priority: 0 }],
      skillIds: ['repository:persistence', 'studio:business'],
      issues: [
        { id: 'lost-write', blocker: true, source: 'src/cache.ts', skillIds: ['repository:persistence'], requirementIds: [] },
        { id: 'quota-bypass', blocker: true, source: 'src/quota.ts', skillIds: ['studio:business'], requirementIds: ['requirement:fixture:quota'] },
      ],
      baseline: { analyses: { security: capturedAnalysis('security', [baselineWrite, falsePositive]),
        integrity: capturedAnalysis('integrity', [baselineRepeat]) },
      labels: { [baselineWrite.id]: 'lost-write', [baselineRepeat.id]: 'lost-write', [falsePositive.id]: null },
      duplicatePairs: [{ findingIds: [baselineWrite.id, baselineRepeat.id], sameIssue: true },
        { findingIds: [baselineWrite.id, falsePositive.id], sameIssue: false }] },
      enriched: { analyses: { security: capturedAnalysis('security', [write]), integrity: capturedAnalysis('integrity', [repeated]),
        business: capturedAnalysis('business', [quota]) },
      labels: { [write.id]: 'lost-write', [repeated.id]: 'lost-write', [quota.id]: 'quota-bypass' },
      duplicatePairs: [{ findingIds: [write.id, repeated.id], sameIssue: true }, { findingIds: [write.id, quota.id], sameIssue: false }] },
    },
    { id: 'insufficient-business-policy', description: 'No authoritative business material: a replay must not fabricate a policy pass.',
      capturedFiles: [], requirements: [], skillIds: [], issues: [],
      baseline: { analyses: { business: falsePass }, labels: {}, duplicatePairs: [] },
      enriched: { analyses: { business: missing }, labels: {}, duplicatePairs: [] } },
  ];
}

export function runReviewQualityReplay(): ReviewQualityEvaluation[] {
  return createReviewQualityReplayFixtures().map(evaluateReviewQualityFixture);
}
