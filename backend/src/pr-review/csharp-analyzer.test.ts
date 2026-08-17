import { describe, expect, it } from 'vitest';
import { createCSharpAnalyzer } from './csharp-analyzer.js';

const analyzer = createCSharpAnalyzer();

describe('createCSharpAnalyzer', () => {
  it('handles only .cs files and matches .csproj manifests', () => {
    expect(analyzer.handles('src/Store.cs')).toBe(true);
    expect(analyzer.handles('src/STORE.CS')).toBe(true);
    expect(analyzer.handles('src/store.ts')).toBe(false);
    expect(analyzer.projectManifest.test('App.csproj')).toBe(true);
    expect(analyzer.projectManifest.test('App.sln')).toBe(false);
  });

  it('extracts the namespace and every top-level type kind', () => {
    const content = `
      namespace My.App.Core;
      public class Service { }
      internal interface IStore { }
      public struct Point { }
      public enum Color { Red }
      public record Dto(int X);
      public partial class Service { }
      public record struct Coord(int Y);
    `;
    const decls = analyzer.declarations(content);
    expect(decls.module).toBe('My.App.Core');
    expect(decls.types.sort()).toEqual(
      ['Color', 'Coord', 'Dto', 'IStore', 'Point', 'Service'].sort(),
    );
  });

  it('returns a null module when no namespace is declared', () => {
    expect(analyzer.declarations('class Loose { }').module).toBeNull();
  });

  it('ignores type keywords that appear only in comments', () => {
    const content = `
      // class Ghost { }
      /* interface Phantom { } */
      namespace App;
      class Real { }
    `;
    const decls = analyzer.declarations(content);
    expect(decls.types).toEqual(['Real']);
  });

  it('detects referenced candidate types with their enclosing member, ignoring comments', () => {
    const content = `
      namespace App;
      class Service {
        public void Run() {
          Store store = new Store();
        }
        // Widget is only mentioned here
      }
    `;
    expect(
      analyzer.references(content, ['Store', 'Widget', 'Missing']),
    ).toEqual([{ type: 'Store', caller: 'Run' }]);
  });

  it('attributes a reference outside any member to a null caller', () => {
    const content = 'namespace App; class Service { Store store; }';
    expect(analyzer.references(content, ['Store'])).toEqual([
      { type: 'Store', caller: null },
    ]);
  });

  it('attributes a reference before any member declaration to a null caller', () => {
    const content = `
      namespace App;
      class Service {
        Store store;
        public void Run() { }
      }
    `;
    expect(analyzer.references(content, ['Store'])).toEqual([
      { type: 'Store', caller: null },
    ]);
  });

  it('does not match a candidate that only appears as a substring', () => {
    const content = 'namespace App; class C { StoreManager m; }';
    expect(analyzer.references(content, ['Store'])).toEqual([]);
  });

  it('ignores a type name that appears only inside a string literal', () => {
    const content = `
      namespace App;
      class Service {
        public void Run() {
          Log.Info("writing to BatchCreator queue");
          Metric.Emit(@"BatchCreator.latency");
          Trace($"batch {count} for BatchCreator done");
        }
      }
    `;
    expect(analyzer.references(content, ['BatchCreator'])).toEqual([]);
  });

  it('ignores a type name that appears only in a using directive', () => {
    const content = `
      using BatchCreator;
      using Alias = Some.BatchCreator;
      global using BatchCreator.Extensions;
      namespace App;
      class Service { }
    `;
    expect(analyzer.references(content, ['BatchCreator'])).toEqual([]);
  });

  it('ignores a type name that appears only in the namespace declaration', () => {
    const content = 'namespace Company.BatchCreator; class Service { }';
    expect(analyzer.references(content, ['BatchCreator'])).toEqual([]);
  });

  it('still detects a genuine usage alongside string/using noise', () => {
    const content = `
      using BatchCreator.Extensions;
      namespace App;
      class Service {
        public void Run() {
          Log.Info("BatchCreator failed");
          BatchCreator creator = new BatchCreator();
        }
      }
    `;
    expect(analyzer.references(content, ['BatchCreator'])).toEqual([
      { type: 'BatchCreator', caller: 'Run' },
    ]);
  });

  it('returns no references when there are no candidate types', () => {
    expect(analyzer.references('class C {}', [])).toEqual([]);
  });
});
