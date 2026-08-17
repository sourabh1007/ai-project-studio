import {
  blankCommentsAndStrings,
  blankMatches,
  escapeForRegExp,
  type CommentStringOptions,
} from './analyzer-text.js';
import type {
  LanguageAnalyzer,
  LanguageDeclarations,
  ReferenceHit,
} from './language-analyzer.js';

/**
 * Declarative configuration for a whole-word, regex-based `LanguageAnalyzer`.
 *
 * Most languages need the same machinery the C# analyzer uses: blank out
 * comments and string literals, find the file's module and declared type names
 * with a few capture-group patterns, then whole-word match candidate types and
 * attribute each hit to the enclosing member. `createRegexLanguageAnalyzer`
 * turns that machinery into shared code so a new language is *only* a config
 * object — no new logic, and every graph feature (edges, boundary callers, the
 * rendered diagram, PR-description export) works for it out of the box.
 *
 * Each pattern's **first capture group** is the extracted name. Patterns need
 * not be global; the factory adds the flag as required.
 */
export interface RegexLanguageConfig {
  /** Stable id used to key this language's type map (e.g. `javascript`). */
  id: string;
  /** Matches the repo-relative paths this language claims. */
  extensions: RegExp;
  /** Matches a project-manifest file name (e.g. `package.json`). */
  projectManifest: RegExp;
  /** Comment/string syntax passed to the shared stripper. */
  stringOptions?: CommentStringOptions;
  /** Captures the file's module/namespace/package name (group 1), if any. */
  modulePattern?: RegExp;
  /** Capture the declared type names (group 1 each). */
  typePatterns: RegExp[];
  /** Capture member/function names for caller attribution (group 1 each). */
  memberPatterns: RegExp[];
  /**
   * Regions blanked before reference matching (e.g. import statements), so a
   * type named in an import does not create a false reference edge.
   */
  ignoreBeforeReferences?: RegExp[];
}

interface MemberSite {
  name: string;
  index: number;
}

/** Ensures a pattern is global so `matchAll` can iterate every occurrence. */
function global(pattern: RegExp): RegExp {
  return pattern.flags.includes('g')
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

/** All first-capture-group names matched by any of `patterns`, de-duplicated. */
function collectNames(code: string, patterns: RegExp[]): string[] {
  const names = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(global(pattern))) {
      names.add(match[1]);
    }
  }
  return [...names];
}

/** Member declaration sites (name + source index), in source order. */
function collectMembers(code: string, patterns: RegExp[]): MemberSite[] {
  const sites: MemberSite[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(global(pattern))) {
      const index = match.index + match[0].lastIndexOf(match[1]);
      sites.push({ name: match[1], index });
    }
  }
  return sites.sort((a, b) => a.index - b.index);
}

/** The member enclosing a reference at `index`: the nearest declared before it. */
function memberAt(members: MemberSite[], index: number): string | null {
  let found: string | null = null;
  for (const member of members) {
    if (member.index <= index) {
      found = member.name;
    } else {
      break;
    }
  }
  return found;
}

export function createRegexLanguageAnalyzer(
  config: RegexLanguageConfig,
): LanguageAnalyzer {
  const stringOptions = config.stringOptions ?? {};
  const strip = (content: string): string =>
    blankCommentsAndStrings(content, stringOptions);

  return {
    id: config.id,
    handles(path) {
      return config.extensions.test(path);
    },
    projectManifest: config.projectManifest,
    declarations(content): LanguageDeclarations {
      const code = strip(content);
      const module = config.modulePattern
        ? config.modulePattern.exec(code)?.[1] ?? null
        : null;
      return { module, types: collectNames(code, config.typePatterns) };
    },
    references(content, candidateTypes) {
      if (candidateTypes.length === 0) {
        return [];
      }
      let code = strip(content);
      for (const pattern of config.ignoreBeforeReferences ?? []) {
        code = blankMatches(code, pattern);
      }
      const members = collectMembers(code, config.memberPatterns);
      const hits: ReferenceHit[] = [];
      const seen = new Set<string>();
      for (const type of candidateTypes) {
        const re = new RegExp(`\\b${escapeForRegExp(type)}\\b`, 'g');
        for (const match of code.matchAll(re)) {
          const caller = memberAt(members, match.index);
          const key = `${type}\u0000${caller ?? ''}`;
          if (!seen.has(key)) {
            seen.add(key);
            hits.push({ type, caller });
          }
        }
      }
      return hits;
    },
  };
}
