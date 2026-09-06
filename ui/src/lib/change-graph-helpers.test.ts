import { describe, expect, it } from 'vitest';
import type { ChangeGraphNode, TestMethodExplanation } from './types.js';
import {
  changeKindLabel,
  contentExtent,
  explanationForSegment,
  LEGEND_KINDS,
  nodeNeedsExplanation,
  reviewFindings,
  UNEXPLAINED_WHAT_CHANGED,
  UNEXPLAINED_WHAT_IT_DOES,
} from './change-graph-helpers.js';

function node(overrides: Partial<ChangeGraphNode> = {}): ChangeGraphNode {
  return {
    path: 'src/a.ts',
    projectId: 'p1',
    module: null,
    category: 'code',
    kind: 'changed',
    changeKind: 'modified',
    diff: '',
    whatItDoes: 'Does a thing.',
    whatChanged: 'Changed a thing.',
    review: [],
    ...overrides,
  };
}

describe('contentExtent', () => {
  it('never shrinks below the base layout when no rects extend past it', () => {
    expect(contentExtent(100, 80, [])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 80,
    });
  });

  it('grows to enclose rects dragged past every edge, including negatives', () => {
    expect(
      contentExtent(100, 80, [
        { x: -30, y: -20, w: 10, h: 10 },
        { x: 120, y: 90, w: 40, h: 30 },
      ]),
    ).toEqual({ minX: -30, minY: -20, maxX: 160, maxY: 120 });
  });
});

describe('nodeNeedsExplanation', () => {
  it('is false when both descriptions are real prose', () => {
    expect(nodeNeedsExplanation(node())).toBe(false);
  });

  it('is true when whatItDoes is blank', () => {
    expect(nodeNeedsExplanation(node({ whatItDoes: '   ' }))).toBe(true);
  });

  it('is true when whatItDoes is still the placeholder', () => {
    expect(
      nodeNeedsExplanation(node({ whatItDoes: UNEXPLAINED_WHAT_IT_DOES })),
    ).toBe(true);
  });

  it('is true when whatChanged is blank', () => {
    expect(nodeNeedsExplanation(node({ whatChanged: '' }))).toBe(true);
  });

  it('is true when whatChanged is still the placeholder', () => {
    expect(
      nodeNeedsExplanation(node({ whatChanged: UNEXPLAINED_WHAT_CHANGED })),
    ).toBe(true);
  });
});

describe('reviewFindings', () => {
  it('strips bullet prefixes and drops empty entries from an array', () => {
    expect(reviewFindings(['- one', '* two', '\u2022 three', '  '])).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('splits a legacy prose string into lines', () => {
    expect(
      reviewFindings('- first\n- second' as unknown as string[]),
    ).toEqual(['first', 'second']);
  });

  it('returns an empty list for a non-array, non-string value', () => {
    expect(reviewFindings(null as unknown as string[])).toEqual([]);
  });
});

describe('changeKindLabel', () => {
  it.each([
    ['added', 'New test'],
    ['deleted', 'Removed test'],
    ['modified', 'Updated test'],
    ['renamed', 'Updated test'],
  ] as const)('labels a %s test change as "%s"', (kind, label) => {
    expect(changeKindLabel(kind, 'test')).toBe(label);
  });

  it('capitalises the raw kind for code files', () => {
    expect(changeKindLabel('added', 'code')).toBe('Added');
    expect(changeKindLabel('renamed', 'code')).toBe('Renamed');
  });
});

describe('explanationForSegment', () => {
  const methods: TestMethodExplanation[] = [
    { name: 'handles empty input', whatChanged: '  Now guards null.  ' },
    { name: 'retries', whatChanged: '' },
  ];

  it('returns null when there is no segment name', () => {
    expect(explanationForSegment(null, methods)).toBeNull();
  });

  it('matches case-insensitively and trims the explanation', () => {
    expect(explanationForSegment('Handles Empty Input', methods)).toBe(
      'Now guards null.',
    );
  });

  it('matches when the method name contains the segment name', () => {
    expect(explanationForSegment('empty', methods)).toBe('Now guards null.');
  });

  it('matches when the segment name contains the method name', () => {
    expect(explanationForSegment('retries on failure', methods)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(explanationForSegment('unknown', methods)).toBeNull();
  });
});

describe('LEGEND_KINDS', () => {
  it('lists the change kinds in display order', () => {
    expect(LEGEND_KINDS).toEqual(['added', 'modified', 'deleted', 'renamed']);
  });
});
