import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ValidationError, ProviderError } from '../kernel/error-types.js';
import type { ReviewFinding, PerspectiveAnalysis } from './review-board-contract.js';
import type { ReviewFindingAction, ReviewFindingEvent, ReviewFindingGroup, ReviewOptions, ReviewRun } from './review-run-contract.js';
import { REVIEW_PERSPECTIVE_IDS } from './review-board-perspective-prompts.js';
import { hasCapturedLine } from '../pr-review/pr-comment-location.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import { statusForSeverity } from './review-board-builder.js';

const optionsSchema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  perspectiveIds: z.array(z.enum(REVIEW_PERSPECTIVE_IDS)).min(1).max(17).optional(),
  skillIds: z.array(z.string().min(1).max(500)).max(50).optional(),
  businessContext: z.string().max(20_000).optional(),
}).strict();

export function parseReviewOptions(raw: unknown): ReviewOptions {
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid review options: ' + parsed.error.message);
  return parsed.data;
}

export function reviewFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function groupReviewFindings(findings: readonly ReviewFinding[]): ReviewFindingGroup[] {
  const groups = new Map<string, ReviewFindingGroup>();
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const finding of findings) {
    const key = reviewFingerprint([
      normalize(finding.title), normalize(finding.detail),
      finding.evidence.map((entry) => [entry.source, entry.location]).sort(),
    ]);
    let group = groups.get(key);
    if (!group) {
      group = { id: key, finding, observations: [], perspectiveIds: [], skillIds: [] };
      groups.set(key, group);
    }
    group.observations.push(finding);
    group.perspectiveIds = [...new Set([...group.perspectiveIds, finding.perspectiveId])];
    group.skillIds = [...new Set([...group.skillIds, ...finding.skillIds ?? []])];
    const order = ['critical', 'high', 'medium', 'low', 'suggestion'];
    if (order.indexOf(finding.severity) < order.indexOf(group.finding.severity)) group.finding = finding;
  }
  const order = ['critical', 'high', 'medium', 'low', 'suggestion'];
  return [...groups.values()].sort((a, b) => order.indexOf(a.finding.severity) - order.indexOf(b.finding.severity));
}

const findingActionSchema = z.object({
  expectedRunId: z.string().min(1).max(200),
  expectedAssessmentRevision: z.number().int().nonnegative(),
  action: z.enum(['merge', 'split', 'disposition', 'severity', 'undo']),
  groupIds: z.array(z.string().min(1).max(200)).max(400),
  reason: z.string().trim().min(1).max(2000),
  disposition: z.enum(['open', 'dismissed', 'fix-verified']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'suggestion']).optional(),
  targetEventId: z.string().min(1).max(200).optional(),
}).strict();

export function parseFindingAction(raw: unknown): ReviewFindingAction {
  const parsed = findingActionSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid finding action: ' + parsed.error.message);
  return parsed.data;
}

export function managedReviewFindings(findings: readonly ReviewFinding[], events: readonly ReviewFindingEvent[]): ReviewFindingGroup[] {
  let groups = groupReviewFindings(findings);
  const undone = new Set(events.filter((event) => event.action === 'undo').map((event) => event.targetEventId));
  const active = events.filter((event) => event.action !== 'undo' && !undone.has(event.id));
  const groupOf = (observations: ReviewFinding[]): ReviewFindingGroup => ({
    id: reviewFingerprint(['manual', observations.map((item) => item.id).sort()]),
    finding: observations[0], observations,
    perspectiveIds: [...new Set(observations.map((item) => item.perspectiveId))],
    skillIds: [...new Set(observations.flatMap((item) => item.skillIds ?? []))],
  });
  for (const event of active) {
    const ids = new Set(event.observationIds);
    const matching = groups.filter((group) => group.observations.some((item) => ids.has(item.id)));
    if (event.action === 'merge' || event.action === 'split') {
      const selected = new Set(matching);
      groups = groups.filter((group) => !selected.has(group));
      const observations = matching.flatMap((group) => group.observations);
      groups.push(...(event.action === 'merge' ? [groupOf(observations)] : observations.map((item) => groupOf([item]))));
    }
  }
  const severityOrder = ['critical', 'high', 'medium', 'low', 'suggestion'];
  const decisions = new Map<string, { severity?: ReviewFinding['severity']; disposition?: ReviewFindingEvent }>();
  for (const event of active) {
    for (const id of event.observationIds) {
      const current = decisions.get(id) ?? {};
      if (event.action === 'severity') current.severity = event.severity;
      if (event.action === 'disposition') current.disposition = event;
      decisions.set(id, current);
    }
  }
  return groups.map((group) => {
    const effective = group.observations.map((item) => {
      const decision = decisions.get(item.id);
      const severity = decision?.severity ?? item.severity;
      return {
        finding: { ...item, severity, status: statusForSeverity(severity) },
        disposition: decision?.disposition,
      };
    });
    const dispositions = new Set(effective.map((item) => item.disposition?.disposition ?? 'open'));
    return { ...group,
      finding: effective.map((item) => item.finding).sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity))[0],
      disposition: dispositions.size === 1 ? effective[0].disposition?.disposition ?? 'open' : 'open',
      dispositionReason: effective.map((item) => item.disposition?.reason).filter(Boolean).join('; '),
    };
  }).sort((a, b) => severityOrder.indexOf(a.finding.severity) - severityOrder.indexOf(b.finding.severity));
}

export function createFindingEvent(
  action: ReviewFindingAction, groups: ReviewFindingGroup[], history: ReviewFindingEvent[], id: string, at: string,
): ReviewFindingEvent {
  const selectedIds = new Set(action.groupIds);
  const selected = groups.filter((group) => selectedIds.has(group.id));
  if (new Set(action.groupIds).size !== action.groupIds.length || selected.length !== action.groupIds.length) {
    throw new ValidationError('The selected findings changed. Reload before recording this decision.');
  }
  if ((action.action === 'merge' && selected.length < 2) ||
      (action.action === 'split' && (selected.length !== 1 || selected[0].observations.length < 2)) ||
      (['disposition', 'severity'].includes(action.action) && selected.length === 0) ||
      (action.action === 'disposition' && !action.disposition) ||
      (action.action === 'severity' && !action.severity)) {
    throw new ValidationError('This finding decision needs valid selections and a reasoned outcome.');
  }
  if (action.action === 'undo' && (!history.some((event) => event.id === action.targetEventId && event.action !== 'undo') ||
      history.some((event) => event.action === 'undo' && event.targetEventId === action.targetEventId))) {
    throw new ValidationError('That decision is unavailable or has already been undone.');
  }
  return { id, action: action.action, at, reason: action.reason,
    observationIds: selected.flatMap((group) => group.observations.map((item) => item.id)),
    ...(action.disposition ? { disposition: action.disposition } : {}),
    ...(action.severity ? { severity: action.severity } : {}),
    ...(action.targetEventId ? { targetEventId: action.targetEventId } : {}),
  };
}

export function possibleReviewDuplicates(groups: readonly ReviewFindingGroup[]): Array<{ groupIds: string[]; reason: string }> {
  const anchors = new Map<string, string[]>();
  for (const group of groups) {
    for (const key of new Set(group.observations.flatMap((item) => item.evidence.filter((entry) => entry.location)
      .map((entry) => JSON.stringify(entry.location))))) {
      const ids = anchors.get(key) ?? [];
      ids.push(group.id);
      anchors.set(key, ids);
    }
  }
  return [...anchors.values()].filter((ids) => ids.length > 1).map((groupIds) => ({
    groupIds, reason: 'These concerns cite the same captured line. They may be distinct defects; merge only after comparing cause and correction.',
  }));
}

export function validateRunFindings(
  findings: ReviewFinding[], perspectiveId: string, run: ReviewRun, review: PrReview,
): void {
  const graph = new Map(review.changeGraph.nodes.filter((node) => node.kind === 'changed').map((node) => [node.path, node.diff]));
  const paths = new Map<string, string>();
  for (const line of run.context.evidence.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line) as { path?: unknown; diff?: unknown; source?: unknown } | null;
      if (typeof entry?.path === 'string' && typeof entry.diff === 'string'
          && graph.get(entry.path)?.startsWith(entry.diff)
          && (entry.diff.length > 0 || (typeof entry.source === 'string' && entry.source.length > 0))) {
        paths.set(entry.path, entry.diff);
      }
    } catch {
      // A budget-truncated JSON record is not supplied evidence.
    }
  }
  const skills = new Set(run.context.skills.filter((skill) =>
    skill.perspectiveIds.length === 0 || skill.perspectiveIds.includes(perspectiveId)).map((skill) => skill.id));
  const requirements = new Set(run.context.requirements?.map((item) => item.id));
  for (const finding of findings.filter((item) => item.id.includes('/ai-'))) {
    if (!finding.evidence.some((entry) => [...paths.keys()].some((path) => entry.source.includes(path)))) {
      throw new ProviderError('Finding must cite captured changed code.');
    }
    for (const entry of finding.evidence) {
      if (entry.location && (!paths.has(entry.location.path) ||
          !hasCapturedLine(paths.get(entry.location.path)!, entry.location.line, entry.location.side))) {
        throw new ProviderError('Finding location is not present in the captured diff.');
      }
    }
    if (finding.skillIds?.some((id) => !skills.has(id))) {
      throw new ProviderError('Finding references a skill that was not supplied.');
    }
    if (finding.requirementIds?.some((id) => !requirements.has(id))) throw new ProviderError('Finding references a requirement that was not supplied.');
    finding.id = `${finding.perspectiveId}/ai-${reviewFingerprint([finding.title, finding.detail, finding.evidence]).slice(0, 20)}`;
  }
}

export function validateRunRequirements(
  rows: PerspectiveAnalysis['requirements'], findings: ReviewFinding[], run: ReviewRun, review: PrReview,
  perspectiveId: PerspectiveAnalysis['perspectiveId'],
): void {
  const prior = perspectiveId === 'final-decision'
    ? Object.values(review.reviewBoardAnalysis?.analyses ?? {}).filter((analysis) =>
      analysis.runId === run.id && analysis.perspectiveId !== 'final-decision').flatMap((analysis) => analysis.perspective.findings)
    : [];
  const available = [...findings, ...prior];
  const supplied = new Set(run.context.requirements?.map((item) => item.id));
  const seen = new Set<string>();
  const findingIds = new Set(available.map((item) => item.id));
  for (const row of rows ?? []) {
    if (!supplied.has(row.requirementId)) {
      throw new ProviderError(`Requirement assessment cites unknown or duplicate captured identities. Invalid requirementId: ${JSON.stringify(row.requirementId)}. Valid requirementIds (copy exactly): ${JSON.stringify([...supplied])}.`);
    }
    if (seen.has(row.requirementId) || row.findingIds.some((id) => !findingIds.has(id))) {
      throw new ProviderError('Requirement assessment cites unknown or duplicate captured identities.');
    }
    seen.add(row.requirementId);
    const linked = available.filter((finding) => row.findingIds.includes(finding.id) || finding.requirementIds?.includes(row.requirementId));
    if ((row.assessment === 'supported' && linked.some((finding) => finding.severity !== 'suggestion')) ||
        (row.assessment === 'violated' && linked.length === 0)) {
      throw new ProviderError('Requirement assessment contradicts its linked findings.');
    }
    if (['supported', 'violated'].includes(row.assessment)) {
      validateRunFindings([{ id: 'requirement/ai-check', perspectiveId: 'business', title: 'Requirement evidence',
        detail: row.explanation, evidence: row.evidence, severity: 'medium', status: 'warning' }], 'business', run, review);
    }
  }
}

export function validateRunAnalysis(
  analysis: PerspectiveAnalysis, run: ReviewRun, review: PrReview,
): PerspectiveAnalysis {
  validateRunFindings(analysis.perspective.findings, analysis.perspectiveId, run, review);
  validateRunRequirements(analysis.requirements, analysis.perspective.findings, run, review, analysis.perspectiveId);
  if (analysis.perspectiveId === 'business' && run.context.requirements?.some((requirement) =>
    !analysis.requirements?.some((row) => row.requirementId === requirement.id && ['supported', 'violated'].includes(row.assessment)))) {
    analysis.assessment = 'insufficient-evidence';
  }
  if (analysis.perspectiveId === 'business' && !run.context.businessRequirements.trim()
      && !run.context.requirements?.some((requirement) => requirement.priority < 100)) {
    analysis.assessment = 'insufficient-evidence';
    analysis.skipped = false;
    analysis.skipReason = null;
    analysis.summary = 'No documented business policy was available. Best-effort inferred criteria do not certify business compliance.';
  }
  if (analysis.perspectiveId === 'final-decision') {
    const saved = review.reviewBoardAnalysis?.analyses ?? {};
    const missing = run.perspectiveIds.filter((id) => id !== 'final-decision'
      && (run.failures[id] || saved[id]?.runId !== run.id || saved[id].assessment === 'insufficient-evidence'));
    if (missing.length) {
      analysis.assessment = 'insufficient-evidence';
      analysis.skipped = false;
      analysis.skipReason = null;
      analysis.summary = `Review coverage is incomplete: ${missing.join(', ')}. No merge approval can be certified.`;
    }
  }
  if (analysis.assessment === 'insufficient-evidence') {
    analysis.perspective = { ...analysis.perspective, status: 'needs-review', risk: 'unknown' };
  }
  return analysis;
}
