import { describe, expect, it } from 'vitest';
import {
  detectTestMethodName,
  segmentTestMethods,
} from './test-method-diff.js';

describe('detectTestMethodName', () => {
  it('reads a JS/TS BDD title from it/test/describe, including modifiers', () => {
    expect(detectTestMethodName("it('adds two numbers', () => {")).toBe(
      'adds two numbers',
    );
    expect(detectTestMethodName('test("does a thing", () => {')).toBe(
      'does a thing',
    );
    expect(detectTestMethodName('it.each(cases)(`case %s`, () => {')).toBe(
      'case %s',
    );
    expect(detectTestMethodName('describe(`suite`, () => {')).toBe('suite');
  });

  it('treats a blank BDD title as no name', () => {
    expect(detectTestMethodName("it('', () => {")).toBeNull();
  });

  it('reads a Go test function name', () => {
    expect(detectTestMethodName('func TestParsesInput(t *testing.T) {')).toBe(
      'TestParsesInput',
    );
  });

  it('reads a Python test function name (case-insensitive prefix)', () => {
    expect(detectTestMethodName('def test_parses_input(self):')).toBe(
      'test_parses_input',
    );
    expect(detectTestMethodName('def Test_Upper(self):')).toBe('Test_Upper');
  });

  it('reads a C# xUnit method name with attributes and async', () => {
    expect(
      detectTestMethodName('public async Task Handles_missing_file() {'),
    ).toBe('Handles_missing_file');
    expect(detectTestMethodName('[Fact] public void Adds() {')).toBe('Adds');
    expect(
      detectTestMethodName('internal static void HelperMethod(int x) {'),
    ).toBe('HelperMethod');
  });

  it('reads a Java @Test method name', () => {
    expect(detectTestMethodName('@Test public void addsNumbers() {')).toBe(
      'addsNumbers',
    );
  });

  it('returns null for a line that declares nothing', () => {
    expect(detectTestMethodName('const x = 1;')).toBeNull();
    expect(detectTestMethodName('  expect(x).toBe(1);')).toBeNull();
    expect(detectTestMethodName('void bare()')).toBeNull();
  });
});

describe('segmentTestMethods', () => {
  it('returns no segments for an empty diff', () => {
    expect(segmentTestMethods('')).toEqual([]);
    expect(segmentTestMethods('\n')).toEqual([]);
  });

  it('groups file headers into a leading null-named preamble segment', () => {
    const diff = [
      'diff --git a/foo.test.ts b/foo.test.ts',
      'index 111..222 100644',
      '--- a/foo.test.ts',
      '+++ b/foo.test.ts',
      "@@ -1,2 +1,3 @@ describe('foo', () => {",
      " it('keeps working', () => {",
      '+  const extra = 1;',
      '   expect(extra).toBe(1);',
    ].join('\n');
    const segments = segmentTestMethods(diff);
    expect(segments[0].name).toBeNull();
    expect(segments[0].changed).toBe(false);
    // The hunk header is named from its section heading (describe('foo')).
    expect(segments[1].name).toBe('foo');
    // The `it(` context line starts its own method segment with the change.
    const working = segments.find((s) => s.name === 'keeps working');
    expect(working).toBeDefined();
    expect(working?.changed).toBe(true);
  });

  it('splits two methods within one hunk and marks the changed one', () => {
    const diff = [
      '@@ -10,8 +10,9 @@',
      " it('first', () => {",
      '   expect(1).toBe(1);',
      ' });',
      " it('second', () => {",
      '+  expect(2).toBe(2);',
      ' });',
    ].join('\n');
    const segments = segmentTestMethods(diff);
    const names = segments.map((s) => s.name);
    expect(names).toContain('first');
    expect(names).toContain('second');
    expect(segments.find((s) => s.name === 'first')?.changed).toBe(false);
    expect(segments.find((s) => s.name === 'second')?.changed).toBe(true);
  });

  it('detects removed lines as a change', () => {
    const diff = [
      "func TestGone(t *testing.T) {",
      '-  t.Fatal("boom")',
      '}',
    ].join('\n');
    const [segment] = segmentTestMethods(diff);
    expect(segment.name).toBe('TestGone');
    expect(segment.changed).toBe(true);
  });

  it('keeps a change with no detectable method in the preamble', () => {
    const diff = ['+import os', '+import sys'].join('\n');
    const segments = segmentTestMethods(diff);
    expect(segments).toHaveLength(1);
    expect(segments[0].name).toBeNull();
    expect(segments[0].changed).toBe(true);
  });

  it('treats a malformed @@-prefixed line as an unnamed segment', () => {
    const diff = ['@@ not a real hunk header', '+x'].join('\n');
    const [segment] = segmentTestMethods(diff);
    expect(segment.name).toBeNull();
    expect(segment.changed).toBe(true);
  });
});
