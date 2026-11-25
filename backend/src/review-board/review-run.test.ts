import { describe, expect, it } from 'vitest';
import { createFindingEvent, groupReviewFindings, managedReviewFindings, parseFindingAction, parseReviewOptions, possibleReviewDuplicates, reviewFingerprint, validateRunAnalysis } from './review-run.js';
import type { ReviewFinding, PerspectiveAnalysis } from './review-board-contract.js';
import type { ReviewRun } from './review-run-contract.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';

const finding: ReviewFinding = {
  id: 'security/ai-0', perspectiveId: 'security', title: 'Validate the key',
  detail: 'key.ts BuildKey accepts unbounded input.', severity: 'medium', status: 'warning',
  evidence: [{ source: 'key.ts', reason: 'Unbounded key', confidence: 1, direct: false }],
};
const run: ReviewRun = {
  id: 'r', revision: 0, status: 'prepared', options: {}, providerId: 'p', model: 'auto',
  perspectiveIds: ['security'], headSha: 'head', graphGeneratedAt: 'graph',
  startedAt: 'now', failures: {},
  context: { fingerprint: 'f', skills: [{ id: 'skill', name: 'Policy', source: 'AGENTS.md',
    content: 'Bound keys', fingerprint: 's', perspectiveIds: ['security'] }],
  businessRequirements: '', evidence: JSON.stringify({ path: 'key.ts', diff: '@@ -1 +1 @@\n-old\n+new' }), warnings: [] },
};
const review = { changeGraph: { nodes: [{ kind: 'changed', path: 'key.ts',
  diff: '@@ -1 +1 @@\n-old\n+new' }, { kind: 'boundary', path: 'caller.ts', diff: '' }] } } as PrReview;
function analysis(item = finding): PerspectiveAnalysis {
  return { perspectiveId: item.perspectiveId, perspective: { id: item.perspectiveId, name: 'Security',
    why: 'Review', source: 'core', status: 'warning', risk: 'medium', findings: [structuredClone(item)] },
  skipped: false, skipReason: null, summary: 'Inspected key', rationale: [], checks: [] };
}

describe('review run contracts', () => {
  it('records reversible grouping without losing original observations or independent defects at one line', () => {
    const first = { ...finding, severity: 'high' as const, evidence: [{ ...finding.evidence[0], location: { path: 'key.ts', line: 1, side: 'RIGHT' as const } }] };
    const second = { ...first, id: 'testing/ai-1', perspectiveId: 'testing', title: 'Check the limit', severity: 'low' as const, skillIds: ['s'] };
    const initial = managedReviewFindings([first, second], []);
    expect(possibleReviewDuplicates(initial)).toHaveLength(1);
    const action = { expectedRunId: 'r', expectedAssessmentRevision: 0, action: 'merge' as const,
      groupIds: initial.map((group) => group.id), reason: 'Same cause and correction' };
    expect(parseFindingAction(action)).toEqual(action);
    const merge = createFindingEvent(action, initial, [], 'merge', 'now');
    const merged = managedReviewFindings([first, second], [merge]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ finding: { severity: 'high' }, skillIds: ['s'], perspectiveIds: ['security', 'testing'] });
    expect(merged[0].observations).toEqual([first, second]);
    const split = createFindingEvent({ ...action, action: 'split', groupIds: [merged[0].id], reason: 'Actually distinct causes' }, merged, [merge], 'split', 'later');
    expect(managedReviewFindings([first, second], [merge, split])).toHaveLength(2);
    const undo = createFindingEvent({ ...action, action: 'undo', groupIds: [], targetEventId: split.id }, merged, [merge, split], 'undo', 'later');
    expect(managedReviewFindings([first, second], [merge, split, undo])).toHaveLength(1);
    expect(() => createFindingEvent({ ...action, action: 'undo', groupIds: [], targetEventId: split.id }, merged, [merge, split, undo], 'again', 'later')).toThrow('already');
    expect(possibleReviewDuplicates(merged)).toEqual([]);
    expect(possibleReviewDuplicates([])).toEqual([]);
  });
  it('keeps publication independent of reasoned dispositions and preserves severity override history', () => {
    const second = { ...finding, id: 'testing/ai-2', title: 'Another defect', severity: 'critical' as const };
    const original = [finding, second];
    const initial = managedReviewFindings(original, []);
    const disposition = createFindingEvent({ expectedRunId: 'r', expectedAssessmentRevision: 0, action: 'disposition',
      groupIds: [initial[0].id], reason: 'Verified by regression test run', disposition: 'fix-verified' }, initial, [], 'd', 'now');
    const severity = createFindingEvent({ expectedRunId: 'r', expectedAssessmentRevision: 1, action: 'severity',
      groupIds: [initial[1].id], reason: 'Supported impact is lower', severity: 'suggestion' }, initial, [disposition], 's', 'now');
    const merge = createFindingEvent({ expectedRunId: 'r', expectedAssessmentRevision: 2, action: 'merge',
      groupIds: initial.map((group) => group.id), reason: 'Shared cause' }, initial, [disposition, severity], 'm', 'now');
    const result = managedReviewFindings(original, [disposition, severity, merge])[0];
    expect(result.disposition).toBe('open');
    expect(result.dispositionReason).toContain('Verified');
    expect(result.finding.severity).toBe('critical');
    expect(original[0].severity).toBe('medium');
    expect(managedReviewFindings(original, [disposition])[0].disposition).toBe('fix-verified');
    expect(managedReviewFindings([], [])).toEqual([]);
  });
  it('rejects stale selections, invalid grouping, missing outcomes and invented undo targets', () => {
    const groups = managedReviewFindings([finding], []);
    const action = { expectedRunId: 'r', expectedAssessmentRevision: 0, action: 'merge' as const, groupIds: [groups[0].id], reason: 'Because' };
    expect(() => parseFindingAction({ ...action, reason: ' ' })).toThrow('Invalid');
    for (const extra of [
      { groupIds: ['missing'] }, { groupIds: [groups[0].id, groups[0].id] },
      {}, { action: 'split' as const }, { action: 'split' as const, groupIds: [] },
      { action: 'disposition' as const, groupIds: [] }, { action: 'disposition' as const },
      { action: 'severity' as const }, { action: 'undo' as const, targetEventId: 'missing' },
    ]) expect(() => createFindingEvent({ ...action, ...extra }, groups, [], 'e', 'now')).toThrow();
    const duplicate = { ...finding, id: 'testing/ai-2', perspectiveId: 'testing' };
    expect(managedReviewFindings([finding, duplicate], []).map((group) => group.observations.length)).toEqual([2]);
  });
  it('validates bounded options and rejects unknown fields and perspectives', () => {
    expect(parseReviewOptions({ model: ' named ', perspectiveIds: ['business'], skillIds: ['s'], businessContext: 'rule' }))
      .toEqual({ model: 'named', perspectiveIds: ['business'], skillIds: ['s'], businessContext: 'rule' });
    for (const raw of [null, { extra: true }, { perspectiveIds: ['made-up'] }, { model: '' },
      { skillIds: [''] }, { businessContext: 'a'.repeat(20_001) }]) {
      expect(() => parseReviewOptions(raw)).toThrow('Invalid review options');
    }
    expect(reviewFingerprint({ a: 1 })).toBe(reviewFingerprint({ a: 1 }));
  });
  it('groups only identical concerns and retains skill/perspective provenance and stronger severity', () => {
    const groups = groupReviewFindings([finding,
      { ...finding, id: 'testing/ai-1', perspectiveId: 'testing', severity: 'high', skillIds: ['s'] },
      { ...finding, id: 'quality/ai-2', perspectiveId: 'code-quality', severity: 'suggestion' },
      { ...finding, title: 'Different defect', skillIds: ['x'] }]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ perspectiveIds: ['security', 'testing', 'code-quality'], skillIds: ['s'],
      finding: { severity: 'high' } });
    expect(groupReviewFindings([])).toEqual([]);
    expect(groups[0].observations).toHaveLength(3);
  });
  it('keeps different locations and causes separate', () => {
    expect(groupReviewFindings([finding, { ...finding, detail: 'Different cause' },
      { ...finding, evidence: [{ ...finding.evidence[0], location: { path: 'key.ts', line: 1, side: 'RIGHT' } }] }]))
      .toHaveLength(3);
  });
  it('validates supplied skills and captured RIGHT anchors and assigns content identities', () => {
    const result = validateRunAnalysis(analysis({ ...finding, skillIds: ['skill'],
      evidence: [{ ...finding.evidence[0], location: { path: 'key.ts', line: 1, side: 'RIGHT' } }] }), run, review);
    expect(result.perspective.findings[0].id).toMatch(/^security\/ai-[a-f0-9]{20}$/);
    expect(() => validateRunAnalysis(analysis({ ...finding, skillIds: ['unknown'] }), run, review)).toThrow('skill');
    expect(() => validateRunAnalysis(analysis({ ...finding, evidence: [{ ...finding.evidence[0], source: 'unknown.ts' }] }), run, review))
      .toThrow('captured changed code');
    for (const location of [{ path: 'key.ts', line: 99, side: 'RIGHT' as const },
      { path: 'missing.ts', line: 1, side: 'LEFT' as const }]) {
      expect(() => validateRunAnalysis(analysis({ ...finding, evidence: [{ ...finding.evidence[0], location }] }), run, review))
        .toThrow('captured diff');
    }
    expect(validateRunAnalysis(analysis({ ...finding, evidence: [{ ...finding.evidence[0],
      location: { path: 'key.ts', line: 1, side: 'LEFT' } }] }), run, review)).toBeDefined();
    expect(validateRunAnalysis(analysis({ ...finding, id: 'deterministic' }), run, review)).toBeDefined();
  });
  it('does not turn absent business requirements or insufficient evidence into a pass', () => {
    const business = analysis({ ...finding, id: 'business/ai-0', perspectiveId: 'business' });
    const result = validateRunAnalysis(business, run, review);
    expect(result.assessment).toBe('insufficient-evidence');
    expect(result.perspective.status).toBe('needs-review');
    const sufficient = structuredClone(run);
    sufficient.context.businessRequirements = 'Bound keys';
    expect(validateRunAnalysis(analysis({ ...finding, perspectiveId: 'business' }), sufficient, review).assessment).toBeUndefined();
    expect(validateRunAnalysis({ ...analysis(), assessment: 'insufficient-evidence' }, run, review).perspective.risk).toBe('unknown');
  });
  it('accepts supplied source-only code without inventing diff coordinates or accepting an empty record', () => {
    const supplied = structuredClone(run);
    supplied.context.evidence = JSON.stringify({ path: 'key.ts', diff: '', source: 'Actual pinned source' });
    expect(validateRunAnalysis(analysis(), supplied, review)).toBeDefined();
    expect(() => validateRunAnalysis(analysis({ ...finding, evidence: [{ ...finding.evidence[0],
      location: { path: 'key.ts', line: 1, side: 'RIGHT' } }] }), supplied, review)).toThrow('captured diff');
    for (const source of ['', null, 42]) {
      supplied.context.evidence = JSON.stringify({ path: 'key.ts', diff: '', source });
      expect(() => validateRunAnalysis(analysis(), supplied, review)).toThrow('captured changed code');
    }
  });
  it('cannot certify Final Decision before any selected perspective has been assessed', () => {
    const result = validateRunAnalysis({ ...analysis({ ...finding, perspectiveId: 'final-decision' }),
      assessment: 'no-concerns' }, { ...run, perspectiveIds: ['security', 'final-decision'] }, review);
    expect(result.assessment).toBe('insufficient-evidence');
    expect(result.summary).toContain('security');
  });
  it('rejects findings in an omitted file and line ranges omitted from frozen evidence', () => {
    const frozen = structuredClone(run);
    frozen.context.evidence = JSON.stringify({ path: 'key.ts', diff: '@@ -1 +1 @@\n-old\n+new' });
    const expanded = structuredClone(review);
    expanded.changeGraph.nodes.push({ ...expanded.changeGraph.nodes[0], path: 'omitted.ts' });
    expect(() => validateRunAnalysis(analysis({ ...finding,
      evidence: [{ ...finding.evidence[0], source: 'omitted.ts',
        location: { path: 'omitted.ts', line: 1, side: 'RIGHT' } }] }), frozen, expanded)).toThrow('captured changed code');
    expanded.changeGraph.nodes[0].diff += '\n@@ -10 +10 @@\n-old ten\n+new ten';
    expect(() => validateRunAnalysis(analysis({ ...finding,
      evidence: [{ ...finding.evidence[0], location: { path: 'key.ts', line: 10, side: 'RIGHT' } }] }), frozen, expanded)).toThrow('captured diff');
  });
  it('uses retained authoritative requirement clauses when their duplicate business-text projection is compacted away', () => {
    const frozen = structuredClone(run);
    frozen.context.requirements = [{ id: 'r1', text: 'Bound keys', source: 'Explicit criteria', priority: 0, fingerprint: 'hash' }];
    const result = validateRunAnalysis({ ...analysis(),
      perspectiveId: 'business', perspective: { ...analysis().perspective, id: 'business', findings: [] },
      assessment: 'no-concerns',
      requirements: [{ requirementId: 'r1', assessment: 'supported', explanation: 'Guard checked',
        findingIds: [], evidence: finding.evidence }],
    }, frozen, review);
    expect(result.assessment).toBe('no-concerns');
    expect(result.summary).not.toContain('missing');
  });
  it('validates requirement identities, finding links and code evidence before certifying Business', () => {
    const pinned = structuredClone(run);
    pinned.context.businessRequirements = 'Bound every key';
    pinned.context.requirements = [{ id: 'r1', text: 'Bound every key', source: 'Explicit criteria', priority: 0, fingerprint: 'hash' }];
    const business = analysis({ ...finding, id: 'business/ai-0', perspectiveId: 'business', requirementIds: ['r1'] });
    expect(validateRunAnalysis(structuredClone(business), pinned, review).assessment).toBe('insufficient-evidence');
    const row = { requirementId: 'r1', assessment: 'violated' as const, explanation: 'Captured missing guard',
      evidence: finding.evidence, findingIds: [] };
    const result = validateRunAnalysis({ ...structuredClone(business), requirements: [row] }, pinned, review);
    expect(result.assessment).toBeUndefined();
    expect(() => validateRunAnalysis({ ...structuredClone(business), requirements: [{ ...row, assessment: 'supported' }] }, pinned, review)).toThrow('contradicts');
    const empty = { ...structuredClone(business), perspective: { ...business.perspective, findings: [] } };
    expect(() => validateRunAnalysis({ ...empty, requirements: [row] }, pinned, review)).toThrow('contradicts');
    expect(validateRunAnalysis({ ...empty, requirements: [{ ...row, assessment: 'supported' }] }, pinned, review).assessment).toBeUndefined();
    expect(() => validateRunAnalysis(analysis({ ...finding, requirementIds: ['invented'] }), pinned, review)).toThrow('not supplied');
    for (const rows of [[{ ...row, requirementId: 'invented' }], [row, row],
      [{ ...row, findingIds: ['invented'] }], [{ ...row, evidence: [] }]]) {
      expect(() => validateRunAnalysis({ ...structuredClone(business), requirements: rows }, pinned, review)).toThrow();
    }
    expect(validateRunAnalysis({ ...structuredClone(business), requirements: [{ ...row, assessment: 'not-assessed', evidence: [] }] }, pinned, review).assessment)
      .toBe('insufficient-evidence');
    const withPrior = structuredClone(review);
    result.runId = pinned.id;
    withPrior.reviewBoardAnalysis = { headSha: withPrior.headSha!, graphGeneratedAt: withPrior.changeGraph.generatedAt,
      analyses: { business: result, security: { ...result, runId: 'old' }, 'final-decision': { ...result, perspectiveId: 'final-decision' } } };
    const synthesis = { ...structuredClone(empty), perspectiveId: 'final-decision' as const,
      perspective: { ...empty.perspective, id: 'final-decision' as const },
      requirements: [{ ...row, findingIds: [result.perspective.findings[0].id] }] };
    expect(validateRunAnalysis(structuredClone(synthesis), pinned, withPrior).requirements![0].assessment).toBe('violated');
    withPrior.reviewBoardAnalysis.analyses.business.runId = 'old';
    expect(() => validateRunAnalysis(structuredClone(synthesis), pinned, withPrior)).toThrow('identities');
    delete withPrior.reviewBoardAnalysis;
    expect(() => validateRunAnalysis(structuredClone(synthesis), pinned, withPrior)).toThrow('identities');
  });
});
