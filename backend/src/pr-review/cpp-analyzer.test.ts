import { describe, expect, it } from 'vitest';
import { createCppAnalyzer } from './cpp-analyzer.js';

const analyzer = createCppAnalyzer();

describe('createCppAnalyzer', () => {
  it('handles C/C++ source and header extensions', () => {
    for (const path of ['a.c', 'a.cc', 'a.cpp', 'a.cxx', 'a.h', 'a.hpp']) {
      expect(analyzer.handles(path)).toBe(true);
    }
    expect(analyzer.handles('a.rs')).toBe(false);
    expect(analyzer.projectManifest.test('CMakeLists.txt')).toBe(true);
    expect(analyzer.projectManifest.test('Makefile')).toBe(true);
    expect(analyzer.projectManifest.test('App.vcxproj')).toBe(true);
  });

  it('declares classes, structs, unions and enums', () => {
    const content = `
      class Widget { int x; };
      struct Point { int y; };
      union Blob { int a; };
      enum class Color { Red };
    `;
    const decls = analyzer.declarations(content);
    expect(decls.module).toBeNull();
    expect(decls.types.sort()).toEqual(
      ['Blob', 'Color', 'Point', 'Widget'].sort(),
    );
  });

  it('detects a usage in a function and ignores include/string noise', () => {
    const content = [
      '#include "widget.h"',
      'void build() {',
      '  const char* msg = "Widget failed";',
      '  Widget w;',
      '}',
    ].join('\n');
    expect(analyzer.references(content, ['Widget'])).toEqual([
      { type: 'Widget', caller: 'build' },
    ]);
  });

  it('does not attribute a reference to a control-flow keyword', () => {
    const content = [
      'void run() {',
      '  if (ready) {',
      '    Widget w;',
      '  }',
      '}',
    ].join('\n');
    expect(analyzer.references(content, ['Widget'])).toEqual([
      { type: 'Widget', caller: 'run' },
    ]);
  });
});
