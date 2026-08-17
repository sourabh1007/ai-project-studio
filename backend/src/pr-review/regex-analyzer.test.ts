import { describe, expect, it } from 'vitest';
import { createRegexLanguageAnalyzer } from './regex-analyzer.js';

const analyzer = createRegexLanguageAnalyzer({
  id: 'demo',
  extensions: /\.demo$/i,
  projectManifest: /^demo\.json$/i,
  modulePattern: /\bmodule\s+([A-Za-z_][\w.]*)/,
  // First pattern is non-global (factory must add the flag); second is global.
  typePatterns: [/\btype\s+([A-Za-z_]\w*)/, /\bexport\s+([A-Za-z_]\w*)/g],
  memberPatterns: [/\bfn\s+([A-Za-z_]\w*)/],
  ignoreBeforeReferences: [/^[ \t]*import\b[^\n]*/gm],
});

describe('createRegexLanguageAnalyzer', () => {
  it('handles matching extensions and manifests', () => {
    expect(analyzer.handles('src/a.demo')).toBe(true);
    expect(analyzer.handles('src/a.other')).toBe(false);
    expect(analyzer.projectManifest.test('demo.json')).toBe(true);
  });

  it('extracts the module and every declared type', () => {
    const decls = analyzer.declarations(
      'module App.Core\ntype Foo\nexport Bar',
    );
    expect(decls.module).toBe('App.Core');
    expect(decls.types.sort()).toEqual(['Bar', 'Foo']);
  });

  it('returns a null module when the module pattern does not match', () => {
    expect(analyzer.declarations('type Foo').module).toBeNull();
  });

  it('returns a null module when no module pattern is configured', () => {
    const noModule = createRegexLanguageAnalyzer({
      id: 'nm',
      extensions: /\.nm$/,
      projectManifest: /nm\.json/,
      typePatterns: [/\btype\s+(\w+)/],
      memberPatterns: [],
    });
    expect(noModule.declarations('type Foo').module).toBeNull();
    expect(noModule.references('type Foo', ['Foo'])).toEqual([
      { type: 'Foo', caller: null },
    ]);
  });

  it('detects references and attributes them to the enclosing member', () => {
    const content = 'import Foo\nfn run() { Foo Bar Foo }';
    expect(analyzer.references(content, ['Foo', 'Bar', 'Missing'])).toEqual([
      { type: 'Foo', caller: 'run' },
      { type: 'Bar', caller: 'run' },
    ]);
  });

  it('ignores a type that appears only in an ignored import region', () => {
    expect(analyzer.references('import Foo\nother', ['Foo'])).toEqual([]);
  });

  it('attributes a reference before any member to a null caller', () => {
    expect(analyzer.references('Foo\nfn run() {}', ['Foo'])).toEqual([
      { type: 'Foo', caller: null },
    ]);
  });

  it('returns no references without candidate types', () => {
    expect(analyzer.references('Foo', [])).toEqual([]);
  });
});
