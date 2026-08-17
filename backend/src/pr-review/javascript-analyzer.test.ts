import { describe, expect, it } from 'vitest';
import { createJavaScriptAnalyzer } from './javascript-analyzer.js';

const analyzer = createJavaScriptAnalyzer();

describe('createJavaScriptAnalyzer', () => {
  it('handles JS/TS extensions and package.json manifests', () => {
    for (const path of ['a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mjs', 'a.cts']) {
      expect(analyzer.handles(path)).toBe(true);
    }
    expect(analyzer.handles('a.cs')).toBe(false);
    expect(analyzer.projectManifest.test('package.json')).toBe(true);
  });

  it('declares exported classes, types, functions and bindings', () => {
    const content = `
      export class Widget {}
      export interface Shape {}
      export type Id = string;
      export enum Color { Red }
      export function build() {}
      export const factory = 1;
    `;
    expect(analyzer.declarations(content).types.sort()).toEqual(
      ['Color', 'Id', 'Shape', 'Widget', 'build', 'factory'].sort(),
    );
    expect(analyzer.declarations(content).module).toBeNull();
  });

  it('detects a usage and ignores template-literal noise', () => {
    const content = [
      "const log = `building Widget now`;",
      'export function build() {',
      '  return new Widget();',
      '}',
    ].join('\n');
    expect(analyzer.references(content, ['Widget'])).toEqual([
      { type: 'Widget', caller: 'build' },
    ]);
  });
});
