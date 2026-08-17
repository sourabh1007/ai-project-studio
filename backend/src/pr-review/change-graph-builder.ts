import { classifyCategory, classifyCategoryWithProject } from './pr-review-parser.js';
import {
  UNEXPLAINED_WHAT_CHANGED,
  UNEXPLAINED_WHAT_IT_DOES,
} from './pr-review-parser.js';
import type {
  ChangeGraphEdge,
  ChangeGraphEdgeCall,
  ChangeGraphNode,
  ChangeGraphProject,
  PrDiffEntry,
} from './pr-review-contract.js';
import type { ChangeGraphFs } from './change-graph-fs.js';
import type {
  LanguageAnalyzer,
  LanguageAnalyzerRegistry,
  ReferenceHit,
} from './language-analyzer.js';

/** The deterministic reference graph the builder produces for one PR. */
export interface BuiltChangeGraph {
  projects: ChangeGraphProject[];
  nodes: ChangeGraphNode[];
  edges: ChangeGraphEdge[];
}

export interface BuildChangeGraphInput {
  worktreePath: string;
  entries: PrDiffEntry[];
  registry: LanguageAnalyzerRegistry;
  fs: ChangeGraphFs;
  /**
   * Upper bound on files the repo-wide boundary scan reads. Defaults to
   * `MAX_BOUNDARY_SCAN_READS`; overridable so tests can exercise the cap cheaply.
   */
  maxBoundaryReads?: number;
}

/** The synthetic project box for files under no matching project manifest. */
const NO_PROJECT: ChangeGraphProject = {
  id: '__none__',
  name: 'No project',
  path: null,
};

/** The repo-relative directory segments of a path, excluding the file name. */
function dirSegments(path: string): string[] {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.slice(0, -1);
}

/** Derives a project box's display name from its manifest file name. */
function projectName(manifestPath: string): string {
  const slash = manifestPath.lastIndexOf('/');
  const file = slash === -1 ? manifestPath : manifestPath.slice(slash + 1);
  return file.replace(/\.[^.]+$/, '');
}

/**
 * Resolves the project box for a file by walking up its ancestor directories to
 * the nearest one containing a file whose name matches any registered project
 * manifest (C#: the closest `.csproj`). Generic across languages; falls back to
 * the shared "No project" box when no ancestor manifest exists.
 */
async function resolveProject(
  worktreePath: string,
  filePath: string,
  matchers: RegExp[],
  fs: ChangeGraphFs,
  cache: Map<string, ChangeGraphProject>,
): Promise<ChangeGraphProject> {
  const segments = dirSegments(filePath);
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const dir = segments.slice(0, depth).join('/');
    const cached = cache.get(dir);
    if (cached) {
      return cached;
    }
    const names = await fs.listDir(worktreePath, dir);
    const manifest = names.find((name) =>
      matchers.some((matcher) => matcher.test(name)),
    );
    if (manifest) {
      const manifestPath = dir ? `${dir}/${manifest}` : manifest;
      const project: ChangeGraphProject = {
        id: manifestPath,
        name: projectName(manifestPath),
        path: manifestPath,
      };
      cache.set(dir, project);
      return project;
    }
  }
  return NO_PROJECT;
}

interface FileFacts {
  path: string;
  category: 'code' | 'test';
  analyzer: LanguageAnalyzer | null;
  content: string | null;
  module: string | null;
  types: string[];
  /** The file's unified-diff patch, used to scope edges to the changed code. */
  patch: string;
}

/**
 * The added ("+") lines of a unified-diff patch, joined as the new/changed code
 * of the file. Diff file headers (`+++`) are excluded and the leading `+` is
 * stripped. Returns null when the patch adds no lines (an empty or
 * deletion-only patch, or a test stub with no `+` lines), so the caller can fall
 * back to scanning the whole file instead of dropping every edge.
 */
export function addedCodeFromPatch(patch: string): string | null {
  const lines: string[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      lines.push(raw.slice(1));
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Restricts a file's reference hits to those whose referenced type is *also*
 * referenced from the file's added lines, so an edge reflects what the PR
 * actually changed (a changed method/class using another changed file's type)
 * rather than a pre-existing reference elsewhere in the same file. Caller labels
 * come from the full-file scan (`hits`); the changed-code scan only decides
 * which types survive. When the patch adds no lines the file is not scoped.
 */
function scopeHitsToChangedCode(
  hits: ReferenceHit[],
  analyzer: LanguageAnalyzer,
  patch: string,
  candidateTypes: string[],
): ReferenceHit[] {
  const changedCode = addedCodeFromPatch(patch);
  if (changedCode === null) {
    return hits;
  }
  const changedTypes = new Set(
    analyzer.references(changedCode, candidateTypes).map((hit) => hit.type),
  );
  return hits.filter((hit) => changedTypes.has(hit.type));
}

/**
 * Builds the deterministic change graph for a PR: every changed file becomes a
 * node grouped into its project box, and a directed edge `A → B` is drawn when
 * `A` statically references a type that a *different* changed file `B` declares.
 * Edges are only drawn between files of the same language and the same category
 * (code↔code, test↔test), so the two rendered graphs stay independent. No AI is
 * involved, so this step is instant and can never hang.
 */
export async function buildChangeGraph(
  input: BuildChangeGraphInput,
): Promise<BuiltChangeGraph> {
  const { worktreePath, entries, registry, fs } = input;
  const maxBoundaryReads = input.maxBoundaryReads ?? MAX_BOUNDARY_SCAN_READS;
  const matchers = registry.manifestMatchers();
  const projectCache = new Map<string, ChangeGraphProject>();
  const projectsById = new Map<string, ChangeGraphProject>();

  const facts: FileFacts[] = [];
  const nodes: ChangeGraphNode[] = [];

  for (const entry of entries) {
    const analyzer = registry.analyzerFor(entry.path);
    const content = analyzer
      ? await fs.readFile(worktreePath, entry.path)
      : null;
    const decls =
      analyzer && content ? analyzer.declarations(content) : null;
    const project = await resolveProject(
      worktreePath,
      entry.path,
      matchers,
      fs,
      projectCache,
    );
    projectsById.set(project.id, project);
    const category = classifyCategoryWithProject(entry.path, project.name);
    facts.push({
      path: entry.path,
      category,
      analyzer,
      content,
      module: decls?.module ?? null,
      types: decls?.types ?? [],
      patch: entry.patch,
    });
    nodes.push({
      path: entry.path,
      projectId: project.id,
      module: decls?.module ?? null,
      category,
      kind: 'changed',
      changeKind: entry.status,
      diff: entry.patch,
      whatItDoes: UNEXPLAINED_WHAT_IT_DOES,
      whatChanged: UNEXPLAINED_WHAT_CHANGED,
      review: [],
    });
  }

  // Index declared types per (language, category) so references only match
  // types declared by changed files sharing both.
  const typeIndex = new Map<string, Map<string, Set<string>>>();
  for (const file of facts) {
    if (!file.analyzer || file.types.length === 0) {
      continue;
    }
    const key = `${file.analyzer.id}::${file.category}`;
    let byType = typeIndex.get(key);
    if (!byType) {
      byType = new Map<string, Set<string>>();
      typeIndex.set(key, byType);
    }
    for (const type of file.types) {
      let declarers = byType.get(type);
      if (!declarers) {
        declarers = new Set<string>();
        byType.set(type, declarers);
      }
      declarers.add(file.path);
    }
  }

  const edges = new Map<string, ChangeGraphEdge>();
  for (const file of facts) {
    if (!file.analyzer || !file.content) {
      continue;
    }
    const byType = typeIndex.get(`${file.analyzer.id}::${file.category}`);
    if (!byType) {
      continue;
    }
    const candidates = [...byType.keys()];
    const allHits = file.analyzer.references(file.content, candidates);
    const hits = scopeHitsToChangedCode(
      allHits,
      file.analyzer,
      file.patch,
      candidates,
    );
    for (const hit of hits) {
      const declarers = byType.get(hit.type);
      if (!declarers) {
        continue;
      }
      for (const declarer of declarers) {
        if (declarer === file.path) {
          continue;
        }
        addEdgeCall(edges, file.path, declarer, {
          symbol: hit.type,
          caller: hit.caller,
        });
      }
    }
  }

  await addBoundaryCallers({
    worktreePath,
    registry,
    fs,
    matchers,
    typeIndex,
    projectCache,
    projectsById,
    changedPaths: new Set(entries.map((entry) => entry.path)),
    nodes,
    edges,
    maxReads: maxBoundaryReads,
  });

  return { projects: [...projectsById.values()], nodes, edges: [...edges.values()] };
}

/** Accumulates a de-duplicated call onto the edge between `from` and `to`. */
function addEdgeCall(
  edges: Map<string, ChangeGraphEdge>,
  from: string,
  to: string,
  call: ChangeGraphEdgeCall,
): void {
  const id = `${from}\u0000${to}`;
  let edge = edges.get(id);
  if (!edge) {
    edge = { from, to, calls: [] };
    edges.set(id, edge);
  }
  if (
    !edge.calls.some((c) => c.symbol === call.symbol && c.caller === call.caller)
  ) {
    edge.calls.push(call);
  }
}

/**
 * Upper bound on the number of analyzer-handled files the boundary scan will
 * read across the whole worktree. Because callers can live in any project, the
 * scan is repo-wide; this cap guarantees it always terminates quickly even on a
 * very large monorepo instead of reading tens of thousands of files.
 */
const MAX_BOUNDARY_SCAN_READS = 6000;

interface BoundaryScanInput {
  worktreePath: string;
  registry: LanguageAnalyzerRegistry;
  fs: ChangeGraphFs;
  matchers: RegExp[];
  typeIndex: Map<string, Map<string, Set<string>>>;
  projectCache: Map<string, ChangeGraphProject>;
  projectsById: Map<string, ChangeGraphProject>;
  changedPaths: Set<string>;
  nodes: ChangeGraphNode[];
  edges: Map<string, ChangeGraphEdge>;
  maxReads: number;
}

/**
 * Bounded scan for "who is calling the change": walks every unchanged source
 * file in the *whole worktree* (not just the changed files' projects) so callers
 * in other projects/modules are found too, and when one statically references a
 * type a changed file declares, adds it as a blue boundary node with an edge
 * `caller → changed file`. Matches only within the same language and category,
 * never recurses past a single reference hop, and reads at most
 * `MAX_BOUNDARY_SCAN_READS` files so it always terminates fast.
 */
async function addBoundaryCallers(input: BoundaryScanInput): Promise<void> {
  const {
    worktreePath,
    registry,
    fs,
    matchers,
    typeIndex,
    projectCache,
    projectsById,
    changedPaths,
    nodes,
    edges,
    maxReads,
  } = input;

  if (typeIndex.size === 0) {
    return;
  }

  const files = await fs.listFilesRecursive(worktreePath, '');
  let reads = 0;
  for (const filePath of files) {
    if (changedPaths.has(filePath)) {
      continue;
    }
    const analyzer = registry.analyzerFor(filePath);
    if (!analyzer) {
      continue;
    }
    const category = classifyCategory(filePath);
    const byType = typeIndex.get(`${analyzer.id}::${category}`);
    if (!byType) {
      continue;
    }
    if (reads >= maxReads) {
      break;
    }
    reads += 1;
    const content = await fs.readFile(worktreePath, filePath);
    if (!content) {
      continue;
    }
    const hits = analyzer.references(content, [...byType.keys()]);
    let callsChanged = false;
    for (const hit of hits) {
      const declarers = byType.get(hit.type);
      if (!declarers) {
        continue;
      }
      for (const declarer of declarers) {
        callsChanged = true;
        addEdgeCall(edges, filePath, declarer, {
          symbol: hit.type,
          caller: hit.caller,
        });
      }
    }
    if (!callsChanged) {
      continue;
    }
    const project = await resolveProject(
      worktreePath,
      filePath,
      matchers,
      fs,
      projectCache,
    );
    projectsById.set(project.id, project);
    nodes.push({
      path: filePath,
      projectId: project.id,
      module: analyzer.declarations(content).module,
      category,
      kind: 'boundary',
      changeKind: null,
      diff: '',
      whatItDoes: UNEXPLAINED_WHAT_IT_DOES,
      whatChanged: '',
      review: [],
    });
  }
}
