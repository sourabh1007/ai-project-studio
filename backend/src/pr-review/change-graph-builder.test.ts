import { describe, expect, it } from 'vitest';
import { buildChangeGraph } from './change-graph-builder.js';
import {
  createLanguageAnalyzerRegistry,
  type LanguageAnalyzer,
} from './language-analyzer.js';
import { createCSharpAnalyzer } from './csharp-analyzer.js';
import type { ChangeGraphFs } from './change-graph-fs.js';
import type { PrChangeKind, PrDiffEntry } from './pr-review-contract.js';

const WORKTREE = '/wt';

function fakeFs(
  files: Record<string, string | null>,
  dirs: Record<string, string[]>,
  tree: Record<string, string[]> = {},
): ChangeGraphFs {
  return {
    async readFile(_worktree, path) {
      return path in files ? files[path] : null;
    },
    async listDir(_worktree, dir) {
      return dirs[dir] ?? [];
    },
    async listFilesRecursive(_worktree, dir) {
      return tree[dir] ?? [];
    },
  };
}

function entry(path: string, patch = 'patch', status: PrChangeKind = 'modified'): PrDiffEntry {
  return { path, status, patch };
}

const csharpRegistry = createLanguageAnalyzerRegistry([createCSharpAnalyzer()]);

describe('buildChangeGraph', () => {
  it('builds project boxes, orange nodes and a reference edge for C# files', async () => {
    const files = {
      'src/Service.cs': 'namespace App;\nclass Service { Store store; }',
      'src/Store.cs': 'namespace App;\nclass Store { }',
    };
    const dirs = { src: ['App.csproj', 'Service.cs', 'Store.cs'] };

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('src/Service.cs'), entry('src/Store.cs')],
      registry: csharpRegistry,
      fs: fakeFs(files, dirs),
    });

    expect(graph.projects).toEqual([
      { id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' },
    ]);
    expect(graph.nodes).toHaveLength(2);
    for (const node of graph.nodes) {
      expect(node.projectId).toBe('src/App.csproj');
      expect(node.category).toBe('code');
      expect(node.module).toBe('App');
      expect(node.changeKind).toBe('modified');
      expect(node.diff).toBe('patch');
    }
    expect(graph.edges).toEqual([
      {
        from: 'src/Service.cs',
        to: 'src/Store.cs',
        calls: [{ symbol: 'Store', caller: null }],
      },
    ]);
  });

  it('accumulates multiple callers for the same referenced type on one edge', async () => {
    const files = {
      'src/Service.cs':
        'namespace App;\nclass Service {\n  Store field;\n  public void Run() { Store local = new Store(); }\n}',
      'src/Store.cs': 'namespace App;\nclass Store { }',
    };
    const dirs = { src: ['App.csproj', 'Service.cs', 'Store.cs'] };

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('src/Service.cs'), entry('src/Store.cs')],
      registry: csharpRegistry,
      fs: fakeFs(files, dirs),
    });

    expect(graph.edges).toEqual([
      {
        from: 'src/Service.cs',
        to: 'src/Store.cs',
        calls: [
          { symbol: 'Store', caller: null },
          { symbol: 'Store', caller: 'Run' },
        ],
      },
    ]);
  });

  it('groups a repo-root file by a root manifest', async () => {
    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('Root.cs')],
      registry: csharpRegistry,
      fs: fakeFs(
        { 'Root.cs': 'namespace App;\nclass Root { }' },
        { '': ['Root.csproj'] },
      ),
    });

    expect(graph.projects).toEqual([
      { id: 'Root.csproj', name: 'Root', path: 'Root.csproj' },
    ]);
    expect(graph.nodes[0]?.projectId).toBe('Root.csproj');
  });

  it('falls back to the No project box for a non-analyzer file', async () => {
    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('docs/readme.md')],
      registry: csharpRegistry,
      fs: fakeFs({ 'docs/readme.md': '# hi' }, {}),
    });

    expect(graph.projects).toEqual([
      { id: '__none__', name: 'No project', path: null },
    ]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.module).toBeNull();
    expect(graph.edges).toEqual([]);
  });

  it('handles a deleted/unreadable C# file with no content', async () => {
    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('src/Gone.cs', 'patch', 'deleted')],
      registry: csharpRegistry,
      fs: fakeFs({ 'src/Gone.cs': null }, { src: ['App.csproj'] }),
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.module).toBeNull();
    expect(graph.nodes[0]?.changeKind).toBe('deleted');
    expect(graph.edges).toEqual([]);
  });

  it('skips self-edges, dedupes multi-type edges and separates categories', async () => {
    const files = {
      'src/Service.cs':
        'namespace App;\nclass Service : IStore { Store s; Service self; }',
      'src/Store.cs': 'namespace App;\nclass Store { }\ninterface IStore { }',
      'tests/StoreTests.cs': 'namespace App;\nclass StoreTests { Store s; }',
    };
    const dirs = {
      src: ['Src.csproj', 'Service.cs', 'Store.cs'],
      tests: ['Tests.csproj', 'StoreTests.cs'],
    };

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [
        entry('src/Service.cs'),
        entry('src/Store.cs'),
        entry('tests/StoreTests.cs'),
      ],
      registry: csharpRegistry,
      fs: fakeFs(files, dirs),
    });

    // Service references both Store and IStore (declared by Store.cs) => one edge
    // after dedup; its self-reference to Service is dropped; the test-category
    // file cannot reference the code-category Store type.
    expect(graph.edges).toEqual([
      {
        from: 'src/Service.cs',
        to: 'src/Store.cs',
        calls: [
          { symbol: 'Store', caller: null },
          { symbol: 'IStore', caller: null },
        ],
      },
    ]);
    expect(graph.nodes.find((n) => n.path === 'tests/StoreTests.cs')?.category).toBe(
      'test',
    );
  });

  it('classifies a changed file in a test project as a test even when its folder looks like code', async () => {
    const files = {
      'ContainerBuilder/Runner.cs': 'namespace App;\nclass Runner { }',
    };
    // The folder has no "test" token; the test signal lives in the .csproj name.
    const dirs = {
      ContainerBuilder: [
        'Microsoft.Azure.Cosmos.ContainerBuilder.Test.Unit.csproj',
        'Runner.cs',
      ],
    };

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('ContainerBuilder/Runner.cs')],
      registry: csharpRegistry,
      fs: fakeFs(files, dirs),
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.category).toBe('test');
  });

  it('draws no edges when no changed file in a group declares a type', async () => {
    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('src/Notes.cs')],
      registry: csharpRegistry,
      fs: fakeFs(
        { 'src/Notes.cs': 'namespace App;\n// nothing here' },
        { src: ['App.csproj'] },
      ),
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.module).toBe('App');
    expect(graph.edges).toEqual([]);
  });

  it('ignores references to types no changed file declares', async () => {
    const ghostAnalyzer: LanguageAnalyzer = {
      id: 'fake',
      handles: (path) => path.endsWith('.fk'),
      projectManifest: /\.fkproj$/,
      declarations: (content) => ({
        module: null,
        types: content.includes('decl') ? ['Real'] : [],
      }),
      references: () => [{ type: 'Ghost', caller: null }],
    };
    const registry = createLanguageAnalyzerRegistry([ghostAnalyzer]);

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('a.decl.fk'), entry('b.fk')],
      registry,
      fs: fakeFs({ 'a.decl.fk': 'decl body', 'b.fk': 'body' }, {}),
    });

    expect(graph.projects).toEqual([
      { id: '__none__', name: 'No project', path: null },
    ]);
    expect(graph.edges).toEqual([]);
  });

  it('adds cross-project blue boundary caller nodes with caller→changed edges', async () => {
    const files = {
      'src/Store.cs': 'namespace App;\nclass Store { }',
      'web/Caller.cs': 'namespace App.Web;\nclass Caller { Store s; }',
      'src/NoRef.cs': 'namespace App;\nclass NoRef { }',
      'src/notes.md': '# notes',
      'src/StoreTests.cs': 'namespace App;\nclass StoreTests { Store s; }',
    };
    const dirs = {
      src: ['App.csproj', 'Store.cs', 'NoRef.cs'],
      web: ['Web.csproj', 'Caller.cs'],
    };
    const tree = {
      '': [
        'src/Store.cs', // the changed file itself — skipped
        'web/Caller.cs', // caller in a different project
        'src/NoRef.cs', // references nothing changed
        'src/Missing.cs', // unreadable (absent from files) — skipped
        'src/notes.md', // no analyzer — skipped
        'src/StoreTests.cs', // test category, no test types — skipped
      ],
    };

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('src/Store.cs')],
      registry: csharpRegistry,
      fs: fakeFs(files, dirs, tree),
    });

    const caller = graph.nodes.find((n) => n.path === 'web/Caller.cs');
    expect(caller).toMatchObject({
      kind: 'boundary',
      changeKind: null,
      diff: '',
      module: 'App.Web',
      category: 'code',
      projectId: 'web/Web.csproj',
    });
    const store = graph.nodes.find((n) => n.path === 'src/Store.cs');
    expect(store?.kind).toBe('changed');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([
      {
        from: 'web/Caller.cs',
        to: 'src/Store.cs',
        calls: [{ symbol: 'Store', caller: null }],
      },
    ]);
  });

  it('stops the boundary scan once the read cap is reached', async () => {
    const files = {
      'src/Store.cs': 'namespace App;\nclass Store { }',
      'a/CallerA.cs': 'namespace A;\nclass CallerA { Store s; }',
      'b/CallerB.cs': 'namespace B;\nclass CallerB { Store s; }',
    };
    const dirs = {
      src: ['App.csproj', 'Store.cs'],
      a: ['A.csproj', 'CallerA.cs'],
      b: ['B.csproj', 'CallerB.cs'],
    };
    const tree = { '': ['src/Store.cs', 'a/CallerA.cs', 'b/CallerB.cs'] };

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('src/Store.cs')],
      registry: csharpRegistry,
      fs: fakeFs(files, dirs, tree),
      maxBoundaryReads: 1,
    });

    // Only the first analyzer-handled candidate is read; the cap breaks the scan
    // before CallerB, so a single boundary node/edge is produced.
    expect(graph.nodes.map((n) => n.path).sort()).toEqual([
      'a/CallerA.cs',
      'src/Store.cs',
    ]);
    expect(graph.edges).toEqual([
      {
        from: 'a/CallerA.cs',
        to: 'src/Store.cs',
        calls: [{ symbol: 'Store', caller: null }],
      },
    ]);
  });

  it('ignores boundary references to types no changed file declares', async () => {
    const ghostAnalyzer: LanguageAnalyzer = {
      id: 'fake',
      handles: (path) => path.endsWith('.fk'),
      projectManifest: /\.fkproj$/,
      declarations: (content) => ({
        module: null,
        types: content.includes('decl') ? ['Real'] : [],
      }),
      references: () => [{ type: 'Ghost', caller: null }],
    };
    const registry = createLanguageAnalyzerRegistry([ghostAnalyzer]);

    const graph = await buildChangeGraph({
      worktreePath: WORKTREE,
      entries: [entry('a.decl.fk')],
      registry,
      fs: fakeFs(
        { 'a.decl.fk': 'decl body', 'b.fk': 'body' },
        { '': ['app.fkproj'] },
        { '': ['b.fk'] },
      ),
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });
});
