import { describe, expect, it } from 'vitest';
import { findingCommentAnchors } from './finding-comment.js';
import type { ReviewEvidence, ReviewFinding } from './types.js';

const diff = '@@ -9,2 +10,2 @@\n context\n-old\n+new';
const files = [{ path: 'src/a.ts', diff }];
const evidence = (location?: ReviewEvidence['location']): ReviewEvidence => ({
  source: 'src/a.ts', reason: 'Reported here', confidence: 1, direct: false, location,
});
const finding = (entries: ReviewEvidence[], detail = ''): ReviewFinding => ({
  id: 'f', perspectiveId: 'security', title: 'Concern', detail,
  severity: 'high', status: 'warning', evidence: entries,
});

describe('findingCommentAnchors', () => {
  it('uses the precise structured right-side path and line with its preview', () => {
    expect(findingCommentAnchors(finding([evidence({ path: 'src\\a.ts', line: 11, side: 'RIGHT' })]), files))
      .toEqual([{ path: 'src/a.ts', line: 11, text: 'new', legacy: false }]);
  });

  it('does not remap left lines or fall back to prose when structured evidence exists', () => {
    expect(findingCommentAnchors(finding([evidence({ path: 'src/a.ts', line: 10, side: 'LEFT' })], 'a.ts:11'), files))
      .toEqual([]);
  });

  it.each([0, -1, 1.2, Infinity, 999])('rejects invalid or uncaptured line %s', (line) => {
    expect(findingCommentAnchors(finding([evidence({ path: 'src/a.ts', line, side: 'RIGHT' })]), files))
      .toEqual([]);
  });

  it('requires exact paths for structured locations and a captured diff', () => {
    for (const path of ['a.ts', 'src/b.ts']) {
      expect(findingCommentAnchors(finding([evidence({ path, line: 10, side: 'RIGHT' })]), files)).toEqual([]);
    }
    expect(findingCommentAnchors(finding([evidence({ path: 'src/a.ts', line: 10, side: 'RIGHT' })]),
      [{ path: 'src/a.ts', diff: null }])).toEqual([]);
  });

  it('handles distinct captured fragments for one path without duplicates', () => {
    const e = evidence({ path: 'src/a.ts', line: 10, side: 'RIGHT' });
    expect(findingCommentAnchors(finding([e, e]), [
      { path: 'src/a.ts', diff: '@@ -1 +1 @@\n+other' }, ...files,
    ])).toEqual([{ path: 'src/a.ts', line: 10, text: 'context', legacy: false }]);
  });

  it('extracts only explicit legacy file:line references and keeps multiple choices', () => {
    expect(findingCommentAnchors(finding([{
      ...evidence(), source: '`src/a.ts:10`', reason: 'See a.ts:11.',
    }], 'Do not guess 17 or line 99. `a.ts:10`'), files))
      .toEqual([
        { path: 'src/a.ts', line: 10, text: 'context', legacy: true },
        { path: 'src/a.ts', line: 11, text: 'new', legacy: true },
      ]);
  });

  it('rejects ambiguous basenames, partial paths, line/column references and missing coordinates', () => {
    expect(findingCommentAnchors(finding([evidence()], 'a.ts:10'), [
      ...files, { path: 'other/a.ts', diff: null },
    ])).toEqual([]);
    expect(findingCommentAnchors(finding([evidence()], 'other/src/a.ts:10 or src/a.ts:10:2'), files)).toEqual([]);
    expect(findingCommentAnchors(finding([evidence()], 'Line 10 is wrong'), files)).toEqual([]);
    expect(findingCommentAnchors(finding([]), files)).toEqual([]);
  });
});
