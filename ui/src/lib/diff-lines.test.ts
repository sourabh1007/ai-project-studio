import { describe, expect, it } from 'vitest';
import { annotateDiffLines, rightSideLines } from './diff-lines.js';

describe('rightSideLines', () => {
  it('returns [] for an empty diff', () => {
    expect(rightSideLines('')).toEqual([]);
  });

  it('ignores content before the first hunk header', () => {
    const diff = ['diff --git a/x b/x', 'index 1..2', '+++ b/x', '+added'].join(
      '\n',
    );
    // No hunk header at all → nothing selectable.
    expect(rightSideLines(diff)).toEqual([]);
  });

  it('numbers added and context lines from the hunk header', () => {
    const diff = [
      '@@ -1,2 +1,3 @@',
      ' context-a',
      '+added-b',
      ' context-c',
    ].join('\n');
    expect(rightSideLines(diff)).toEqual([
      { line: 1, kind: 'context', text: 'context-a' },
      { line: 2, kind: 'added', text: 'added-b' },
      { line: 3, kind: 'context', text: 'context-c' },
    ]);
  });

  it('skips removed lines without consuming a new-side number', () => {
    const diff = ['@@ -5,2 +5,1 @@', '-gone', '+stays'].join('\n');
    expect(rightSideLines(diff)).toEqual([
      { line: 5, kind: 'added', text: 'stays' },
    ]);
  });

  it('respects the new-side start line from the header', () => {
    const diff = ['@@ -10,1 +20,2 @@', '+first', '+second'].join('\n');
    expect(rightSideLines(diff).map((l) => l.line)).toEqual([20, 21]);
  });

  it('handles a header without line counts', () => {
    const diff = ['@@ -1 +1 @@', '+only'].join('\n');
    expect(rightSideLines(diff)).toEqual([
      { line: 1, kind: 'added', text: 'only' },
    ]);
  });

  it('resets the counter across multiple hunks', () => {
    const diff = [
      '@@ -1,1 +1,1 @@',
      '+a',
      '@@ -8,1 +8,1 @@',
      '+b',
    ].join('\n');
    expect(rightSideLines(diff).map((l) => l.line)).toEqual([1, 8]);
  });

  it('skips file markers and the no-newline sentinel inside a hunk', () => {
    const diff = [
      '@@ -1,1 +1,2 @@',
      '+a',
      '--- a/other',
      '+++ b/other',
      '\\ No newline at end of file',
      '+b',
    ].join('\n');
    expect(rightSideLines(diff).map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('treats a blank in-hunk line as context', () => {
    const diff = ['@@ -1,2 +1,2 @@', '', '+x'].join('\n');
    expect(rightSideLines(diff)).toEqual([
      { line: 1, kind: 'context', text: '' },
      { line: 2, kind: 'added', text: 'x' },
    ]);
  });
});

describe('annotateDiffLines', () => {
  it('returns [] for an empty diff', () => {
    expect(annotateDiffLines('')).toEqual([]);
    expect(annotateDiffLines('\n')).toEqual([]);
  });

  it('classifies file/meta lines before the first hunk with no anchor', () => {
    const diff = ['diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x'].join(
      '\n',
    );
    expect(annotateDiffLines(diff)).toEqual([
      { raw: 'diff --git a/x b/x', kind: 'meta', rightLine: null },
      { raw: 'index 1..2', kind: 'meta', rightLine: null },
      { raw: '--- a/x', kind: 'meta', rightLine: null },
      { raw: '+++ b/x', kind: 'meta', rightLine: null },
    ]);
  });

  it('treats pre-hunk non-meta text as unanchored context', () => {
    expect(annotateDiffLines('preamble')).toEqual([
      { raw: 'preamble', kind: 'ctx', rightLine: null },
    ]);
  });

  it('anchors added and context lines to their new-side numbers', () => {
    const diff = [
      '@@ -1,2 +1,3 @@',
      ' context-a',
      '+added-b',
      '-removed',
      ' context-c',
    ].join('\n');
    expect(annotateDiffLines(diff)).toEqual([
      { raw: '@@ -1,2 +1,3 @@', kind: 'hunk', rightLine: null },
      { raw: ' context-a', kind: 'ctx', rightLine: 1 },
      { raw: '+added-b', kind: 'add', rightLine: 2 },
      { raw: '-removed', kind: 'del', rightLine: null },
      { raw: ' context-c', kind: 'ctx', rightLine: 3 },
    ]);
  });

  it('handles the no-newline marker as unanchored context', () => {
    const diff = ['@@ -1,1 +1,2 @@', '+a', '\\ No newline at end of file'].join(
      '\n',
    );
    expect(annotateDiffLines(diff)).toEqual([
      { raw: '@@ -1,1 +1,2 @@', kind: 'hunk', rightLine: null },
      { raw: '+a', kind: 'add', rightLine: 1 },
      { raw: '\\ No newline at end of file', kind: 'ctx', rightLine: null },
    ]);
  });

  it('classifies a malformed @@ header as a hunk line without moving the counter', () => {
    // A header that does not match the strict pattern still reads as a hunk line
    // for colouring; the running new-side counter is left untouched.
    const diff = ['@@ malformed', '+a'].join('\n');
    expect(annotateDiffLines(diff)).toEqual([
      { raw: '@@ malformed', kind: 'hunk', rightLine: null },
      { raw: '+a', kind: 'add', rightLine: 0 },
    ]);
  });

  it('resets the counter across hunks', () => {
    const diff = ['@@ -1,1 +1,1 @@', '+a', '@@ -8,1 +8,1 @@', '+b'].join('\n');
    expect(
      annotateDiffLines(diff)
        .filter((l) => l.rightLine !== null)
        .map((l) => l.rightLine),
    ).toEqual([1, 8]);
  });
});
