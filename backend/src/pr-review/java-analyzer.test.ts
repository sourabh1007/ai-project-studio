import { describe, expect, it } from 'vitest';
import { createJavaAnalyzer } from './java-analyzer.js';

const analyzer = createJavaAnalyzer();

describe('createJavaAnalyzer', () => {
  it('handles .java files and Maven/Gradle manifests', () => {
    expect(analyzer.handles('src/App.java')).toBe(true);
    expect(analyzer.handles('src/App.kt')).toBe(false);
    expect(analyzer.projectManifest.test('pom.xml')).toBe(true);
    expect(analyzer.projectManifest.test('build.gradle')).toBe(true);
    expect(analyzer.projectManifest.test('build.gradle.kts')).toBe(true);
  });

  it('extracts the package and declared types', () => {
    const content = `
      package com.acme.app;
      public class Service {}
      interface Store {}
      enum Color { Red }
      record Dto(int x) {}
    `;
    const decls = analyzer.declarations(content);
    expect(decls.module).toBe('com.acme.app');
    expect(decls.types.sort()).toEqual(
      ['Color', 'Dto', 'Service', 'Store'].sort(),
    );
  });

  it('detects a usage in a method and ignores import noise', () => {
    const content = `
      package com.acme.app;
      import com.acme.other.Store;
      public class Service {
        public void run() {
          Store store = new Store();
        }
      }
    `;
    expect(analyzer.references(content, ['Store'])).toEqual([
      { type: 'Store', caller: 'run' },
    ]);
  });
});
