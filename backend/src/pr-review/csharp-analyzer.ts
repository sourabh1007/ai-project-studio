import type {
  LanguageAnalyzer,
  LanguageDeclarations,
  ReferenceHit,
} from './language-analyzer.js';

/**
 * The first `LanguageAnalyzer`: C#. It extracts a file's namespace and top-level
 * type declarations, and detects which candidate types a file references, using
 * light regular-expression scans (no full parser). This is deliberately
 * approximate — good enough to draw reference edges between the PR's changed
 * `.cs` files without the cost or hang risk of a real compiler — and accepts a
 * few false edges from common type-name collisions (documented in the plan).
 */

/** Strips line and block comments so declarations/references ignore commented code. */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** The first namespace declared in a file (file-scoped or block), or null. */
function extractNamespace(content: string): string | null {
  const match = /\bnamespace\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(content);
  return match ? match[1] : null;
}

const TYPE_KEYWORDS = 'class|interface|struct|enum|record';

/**
 * The top-level type names declared in a file. Matches `class`/`interface`/
 * `struct`/`enum`/`record` (including `record class`/`record struct` and
 * `partial`), capturing the identifier that follows. Names are de-duplicated so
 * a `partial` type split within one file is reported once.
 */
function extractTypes(content: string): string[] {
  const re = new RegExp(
    `\\b(?:${TYPE_KEYWORDS})\\b(?:\\s+(?:class|struct))?\\s+([A-Za-z_][A-Za-z0-9_]*)`,
    'g',
  );
  const names = new Set<string>();
  for (const match of content.matchAll(re)) {
    names.add(match[1]);
  }
  return [...names];
}

/** Escapes a type name for safe use inside a whole-word RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A method/property declaration and the index where its name appears. */
interface MemberSite {
  name: string;
  index: number;
}

/**
 * Method- and property-like member declarations, in source order. Heuristic: a
 * member is `<modifiers> <return-type> Name(` for methods, or `<modifiers>
 * <type> Name {` for properties — always with a body `{` or expression `=>` so
 * ordinary call sites (which end in `;` or `)`) are not mistaken for
 * declarations. Constructors (no return type) are intentionally skipped. Used to
 * attribute each reference to the member that encloses it.
 */
function extractMembers(code: string): MemberSite[] {
  const modifier =
    '(?:public|private|protected|internal|static|async|virtual|override|' +
    'sealed|new|partial|unsafe|extern|readonly)';
  const method = new RegExp(
    `(?:${modifier}\\s+)+[A-Za-z_][\\w<>,.\\[\\]?\\s]*?\\s+([A-Za-z_]\\w*)\\s*` +
      `\\([^;{}]*\\)\\s*(?:\\{|=>)`,
    'g',
  );
  const property = new RegExp(
    `(?:${modifier}\\s+)+[A-Za-z_][\\w<>,.\\[\\]?]*\\s+([A-Za-z_]\\w*)\\s*\\{\\s*` +
      `(?:get|set|init)`,
    'g',
  );
  const sites: MemberSite[] = [];
  for (const re of [method, property]) {
    for (const match of code.matchAll(re)) {
      // The captured name group starts after the leading modifiers/return type.
      const nameIndex = match.index + match[0].lastIndexOf(match[1]);
      sites.push({ name: match[1], index: nameIndex });
    }
  }
  return sites.sort((a, b) => a.index - b.index);
}

/** The member enclosing a reference at `index`: the nearest one declared before it. */
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

export function createCSharpAnalyzer(): LanguageAnalyzer {
  return {
    id: 'csharp',
    handles(path) {
      return /\.cs$/i.test(path);
    },
    projectManifest: /\.csproj$/i,
    declarations(content): LanguageDeclarations {
      const code = stripComments(content);
      return {
        module: extractNamespace(code),
        types: extractTypes(code),
      };
    },
    references(content, candidateTypes) {
      if (candidateTypes.length === 0) {
        return [];
      }
      const code = stripComments(content);
      const members = extractMembers(code);
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
