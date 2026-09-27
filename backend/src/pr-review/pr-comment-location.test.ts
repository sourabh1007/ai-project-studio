import { describe, expect, it } from 'vitest';
import { assertExpectedHeadSha, hasCapturedRightLine, isRepoRelativePath } from './pr-comment-location.js';

describe('exact comment coordinates', () => {
  it.each(['a.ts', 'src/a b.ts', 'src/é.ts'])('accepts relative path %s unchanged', (path) => {
    expect(isRepoRelativePath(path)).toBe(true);
  });

  it.each([null, 4, '', ' ', '/a.ts', 'a//b', './a', '../a', 'a/../b',
    'a/./b', 'a/', 'C:/a', 'C:\\a', '\\\\server\\a', 'a\\b', 'a\0b', 'a\nb'])(
    'rejects non-exact or non-relative path %j', (path) => {
      expect(isRepoRelativePath(path)).toBe(false);
    },
  );

  it.each([null, undefined, 1, '', '  '])('rejects invalid expected head %j', (value) => {
    expect(() => assertExpectedHeadSha(value)).toThrow(/expectedHeadSha/);
  });

  it('accepts the expected head without rewriting it', () => {
    expect(() => assertExpectedHeadSha('sha')).not.toThrow();
  });

  it('counts only added and context rows, across multiple hunks and CRLF', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts',
      '@@ -3,4 +7,4 @@ fn()', ' context', '-removed', '+added',
      '\\ No newline at end of file', ' context2', ' context3',
      '@@ -40 +50 @@', '-old', '+new',
    ].join('\r\n');
    for (const line of [7, 8, 9, 10, 50]) expect(hasCapturedRightLine(diff, line)).toBe(true);
    for (const line of [3, 6, 11, 40, 49, 51]) expect(hasCapturedRightLine(diff, line)).toBe(false);
  });

  it.each([
    ['', 1],
    ['Binary files differ', 1],
    ['@@ -1,3 +0,0 @@\n-a\n-b\n-c', 1],
    ['@@ -1,2 +1,2 @@\n-a\n-b', 1],
    ['@@ -1,20 +1,20 @@\n+only captured row', 2],
    ['@@ -1 +1 @@\n+one\n+outside hunk count', 2],
    ['@@ -1,3 +1,3 @@\n+one\ntruncation marker\n+not captured', 2],
    ['@@ malformed @@\n+not captured', 1],
  ])('does not invent an anchor in %j at %i', (diff, line) => {
    expect(hasCapturedRightLine(diff, line)).toBe(false);
  });
});
