import { describe, expect, it } from 'vitest';
import { ProviderError } from '../kernel/error-types.js';
import {
  assertReviewQualityGates, createReviewQualityReplayFixtures, evaluateReviewQualityFixture,
  runReviewQualityReplay, type ReviewQualityMetrics,
} from './review-quality-evaluation.js';
import type { ReviewEvidence } from './review-board-contract.js';

describe('labelled comparative review replay (not live vendor benchmarking)', () => {
  it('replays deterministic baseline/enriched captures with measured blocker, false-positive, duplication and attribution outcomes', () => {
    const result = runReviewQualityReplay();
    expect(result).toEqual(runReviewQualityReplay());
    expect(result.every((entry) => entry.label.includes('NOT a live vendor/model benchmark'))).toBe(true);
    expect(result[0]!.baseline).toMatchObject({ evidenceValidity: 1, seededBlockerRecall: 0.5,
      falsePositives: 1, missedBlockers: ['quota-bypass'], duplicateDistinction: 0.5, attributionCorrectness: 0 });
    expect(result[0]!.enriched).toMatchObject({ evidenceValidity: 1, seededBlockerRecall: 1,
      falsePositives: 0, missedBlockers: [], duplicateDistinction: 1, attributionCorrectness: 1, falsePolicyPasses: 0 });
    expect(result[1]!.baseline).toMatchObject({ insufficientBusinessContextCorrect: false, falsePolicyPasses: 1 });
    expect(result[1]!.enriched).toMatchObject({ insufficientBusinessContextCorrect: true, falsePolicyPasses: 0,
      seededBlockerRecall: null, attributionCorrectness: null, duplicateDistinction: null, evidenceValidity: null });
    for (const replay of result) expect(() => assertReviewQualityGates(replay.enriched)).not.toThrow();
    expect(() => assertReviewQualityGates(result[1]!.baseline)).toThrow(ProviderError);
  });

  it('fails evidence gates for unsupported files, coordinates, confidence, empty claims and inferred coverage', () => {
    const variants: Partial<ReviewEvidence>[] = [
      { source: 'not-captured.ts' }, { reason: ' ' }, { confidence: 0 }, { confidence: 2 },
      { confidence: NaN }, { location: { path: 'other.ts', line: 12, side: 'RIGHT' } },
      { location: { path: 'src/quota.ts', line: 999, side: 'RIGHT' } },
      { location: { path: 'src/quota.ts', line: 12, side: 'INVALID' as 'RIGHT' } },
    ];
    for (const variant of variants) {
      const fixture = createReviewQualityReplayFixtures()[0]!;
      const finding = fixture.enriched.analyses.business!.perspective.findings[0]!;
      Object.assign(finding.evidence[0]!, variant);
      const measured = evaluateReviewQualityFixture(fixture).enriched;
      expect(measured.invalidEvidence).toBe(1);
      expect(measured.missedBlockers).toContain('quota-bypass');
      expect(() => assertReviewQualityGates(measured)).toThrow('quality gate failed');
    }
    const fixture = createReviewQualityReplayFixtures()[0]!;
    fixture.enriched.analyses.business!.perspective.findings[0]!.evidence = [];
    expect(evaluateReviewQualityFixture(fixture).enriched.invalidEvidence).toBe(1);
  });

  it('requires issue-matching captured evidence and exact known skill/requirement attribution', () => {
    for (const mutation of ['wrong-source', 'unknown-label', 'unknown-skill', 'unknown-requirement', 'missing-skill', 'wrong-known-skill']) {
      const fixture = createReviewQualityReplayFixtures()[0]!;
      const finding = fixture.enriched.analyses.business!.perspective.findings[0]!;
      if (mutation === 'wrong-source') finding.evidence = [{ source: 'src/cache.ts', direct: true, confidence: 1, reason: 'Different file' }];
      if (mutation === 'unknown-label') fixture.enriched.labels[finding.id] = 'not-seeded';
      if (mutation === 'unknown-skill') finding.skillIds = ['not-supplied'];
      if (mutation === 'unknown-requirement') finding.requirementIds = ['not-captured'];
      if (mutation === 'missing-skill') finding.skillIds = undefined;
      if (mutation === 'wrong-known-skill') finding.skillIds = ['repository:persistence'];
      const measured = evaluateReviewQualityFixture(fixture).enriched;
      if (mutation === 'wrong-source' || mutation === 'unknown-label') expect(measured.falsePositives).toBe(1);
      else expect(measured.attributionCorrectness).toBeLessThan(1);
      expect(() => assertReviewQualityGates(measured)).toThrow();
    }
    const fixture = createReviewQualityReplayFixtures()[0]!;
    const write = fixture.enriched.analyses.security!.perspective.findings[0]!;
    write.requirementIds = undefined;
    write.evidence[0]!.location = { path: 'src/cache.ts', line: 5, side: 'LEFT' };
    write.evidence[0]!.direct = false;
    expect(evaluateReviewQualityFixture(fixture).enriched.evidenceValidity).toBe(1);
  });

  it('measures duplicate distinction independently of issue recall and ignores pairs absent from a capture', () => {
    const fixture = createReviewQualityReplayFixtures()[0]!;
    const write = fixture.enriched.analyses.security!.perspective.findings[0]!;
    const repeated = fixture.enriched.analyses.integrity!.perspective.findings[0]!;
    repeated.detail = 'A differently-worded description of the same labelled issue';
    fixture.enriched.duplicatePairs.push({ findingIds: ['absent', write.id], sameIssue: true });
    expect(evaluateReviewQualityFixture(fixture).enriched.duplicateDistinction).toBe(0.5);
    const quota = fixture.enriched.analyses.business!.perspective.findings[0]!;
    Object.assign(quota, { title: write.title, detail: write.detail, evidence: structuredClone(write.evidence) });
    expect(evaluateReviewQualityFixture(fixture).enriched.duplicateDistinction).toBe(0);
  });

  it('rejects unsupported requirement passes and records missing-policy failures without guessed test coverage', () => {
    for (const variant of ['unknown-id', 'missing-evidence', 'invalid-evidence', 'known', 'unassessed']) {
      const fixture = createReviewQualityReplayFixtures()[0]!;
      const business = fixture.enriched.analyses.business!;
      business.requirements = [{ requirementId: variant === 'unknown-id' ? 'unknown' : fixture.requirements[0]!.id,
        assessment: variant === 'unassessed' ? 'not-assessed' : 'supported', explanation: 'Captured claim',
        evidence: variant === 'missing-evidence' ? [] : variant === 'invalid-evidence'
          ? [{ source: 'unknown', reason: 'not captured', confidence: 1, direct: true }]
          : business.perspective.findings[0]!.evidence, findingIds: [] }];
      expect(evaluateReviewQualityFixture(fixture).enriched.falsePolicyPasses).toBe(['known', 'unassessed'].includes(variant) ? 0 : 1);
    }
    for (const variant of ['skipped', 'approved', 'no-business', 'not-insufficient']) {
      const fixture = createReviewQualityReplayFixtures()[1]!;
      if (variant === 'skipped') fixture.enriched.analyses.business!.skipped = true;
      if (variant === 'approved') fixture.enriched.analyses.business!.perspective.status = 'approved';
      if (variant === 'no-business') fixture.enriched.analyses = {};
      if (variant === 'not-insufficient') fixture.enriched.analyses.business!.assessment = 'not-applicable';
      const measured = evaluateReviewQualityFixture(fixture).enriched;
      expect(measured.insufficientBusinessContextCorrect).toBe(false);
      expect(() => assertReviewQualityGates(measured)).toThrow();
    }
  });

  it('fails each independent labelled replay quality gate', () => {
    const clean = runReviewQualityReplay()[0]!.enriched;
    const changes: Partial<ReviewQualityMetrics>[] = [
      { invalidEvidence: 1 }, { falsePolicyPasses: 1 }, { falsePositives: 1 }, { missedBlockers: ['seed'] },
      { duplicateDistinction: 0 }, { duplicateDistinction: 0.5 }, { attributionCorrectness: 0 },
      { insufficientBusinessContextCorrect: false },
    ];
    for (const change of changes) expect(() => assertReviewQualityGates({ ...clean, ...change })).toThrow(ProviderError);
  });
});
