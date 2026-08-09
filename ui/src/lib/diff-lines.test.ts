import { describe, expect, it } from 'vitest';
import { rightSideLines } from './diff-lines.js';

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
