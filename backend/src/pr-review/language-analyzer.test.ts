import { describe, expect, it } from 'vitest';
import {
  createLanguageAnalyzerRegistry,
  type LanguageAnalyzer,
} from './language-analyzer.js';

function fakeAnalyzer(
  id: string,
  ext: RegExp,
  manifest: RegExp,
): LanguageAnalyzer {
  return {
    id,
    handles: (path) => ext.test(path),
    projectManifest: manifest,
    declarations: () => ({ module: null, types: [] }),
    references: () => [],
  };
}

describe('createLanguageAnalyzerRegistry', () => {
  it('returns the first analyzer whose handles matches, or null', () => {
    const cs = fakeAnalyzer('csharp', /\.cs$/i, /\.csproj$/i);
    const ts = fakeAnalyzer('ts', /\.ts$/i, /package\.json$/i);
    const registry = createLanguageAnalyzerRegistry([cs, ts]);

    expect(registry.analyzerFor('src/Store.cs')?.id).toBe('csharp');
    expect(registry.analyzerFor('src/store.ts')?.id).toBe('ts');
    expect(registry.analyzerFor('README.md')).toBeNull();
  });

  it('exposes every registered manifest matcher', () => {
    const cs = fakeAnalyzer('csharp', /\.cs$/i, /\.csproj$/i);
    const ts = fakeAnalyzer('ts', /\.ts$/i, /package\.json$/i);
    const registry = createLanguageAnalyzerRegistry([cs, ts]);

    const matchers = registry.manifestMatchers();
    expect(matchers).toHaveLength(2);
    expect(matchers.some((m) => m.test('App.csproj'))).toBe(true);
    expect(matchers.some((m) => m.test('package.json'))).toBe(true);
  });
});
