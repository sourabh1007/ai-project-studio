/**
 * The pluggable language layer of the deterministic change graph. A
 * `LanguageAnalyzer` teaches the builder how to read one language's files: which
 * paths it handles, what file marks a project box, what types a file declares,
 * and which candidate types a file references. New languages are added by
 * implementing this interface and registering it — the builder, service and UI
 * never change. C# is the first analyzer (see `csharp-analyzer.ts`).
 */
export interface LanguageDeclarations {
  /** A finer-grained grouping label for the file (C#: its namespace); null when none. */
  module: string | null;
  /** The top-level type names this file declares (class/interface/struct/…). */
  types: string[];
}

/**
 * One reference from a file to a type another changed file declares. `type` is
 * the referenced type name; `caller` is the enclosing function/member in the
 * referencing file where the reference occurs, or null when it could not be
 * attributed (e.g. a field declaration outside any member).
 */
export interface ReferenceHit {
  type: string;
  caller: string | null;
}

/** A single language's static-analysis rules for the change-graph builder. */
export interface LanguageAnalyzer {
  /** Stable id used to key this language's type map (e.g. `csharp`). */
  id: string;
  /** True when this analyzer understands the given repo-relative path. */
  handles(path: string): boolean;
  /**
   * Matches a project-manifest file name. The nearest ancestor file whose name
   * matches becomes the project box a file is grouped into (C#: `\.csproj$`).
   */
  projectManifest: RegExp;
  /** The module + declared type names extracted from a file's full content. */
  declarations(content: string): LanguageDeclarations;
  /**
   * Which of `candidateTypes` this file references, and the enclosing member of
   * each reference. `candidateTypes` are the types declared by *other* changed
   * files of the same language and category, so a returned hit means "this file
   * uses a type another changed file declares" — i.e. a reference edge, labelled
   * with the calling member when it can be determined.
   */
  references(content: string, candidateTypes: string[]): ReferenceHit[];
}

/** A registry of language analyzers, chosen per file by `handles`. */
export interface LanguageAnalyzerRegistry {
  /** The analyzer that handles a path, or null when no language claims it. */
  analyzerFor(path: string): LanguageAnalyzer | null;
  /** Every registered project-manifest matcher, for generic box resolution. */
  manifestMatchers(): RegExp[];
}

/**
 * Builds a registry from an ordered list of analyzers. The first analyzer whose
 * `handles` returns true wins, so more specific analyzers should be listed
 * first.
 */
export function createLanguageAnalyzerRegistry(
  analyzers: LanguageAnalyzer[],
): LanguageAnalyzerRegistry {
  return {
    analyzerFor(path) {
      return analyzers.find((analyzer) => analyzer.handles(path)) ?? null;
    },
    manifestMatchers() {
      return analyzers.map((analyzer) => analyzer.projectManifest);
    },
  };
}
