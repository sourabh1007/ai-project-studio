/**
 * Shared, language-neutral source-text sanitisers used by `LanguageAnalyzer`s.
 *
 * The change-graph analyzers detect declarations and references with light
 * regular-expression scans rather than a full parser. To avoid false matches,
 * they must first blank out regions that look like code but are not — comments
 * and string/char literals. A type name mentioned inside a log message, a
 * telemetry key, or a `using` alias must never create a reference edge.
 *
 * `blankCommentsAndStrings` performs a single left-to-right pass and replaces
 * every commented or quoted character with a space (newlines are preserved), so
 * the returned string has the **same length** as the input. Callers can then run
 * their existing index-based scans unchanged.
 *
 * The comment/string syntax handled here (`//`, `/* *\/`, `"..."`, `'...'`) is
 * shared by the whole C family — C#, C, C++, Java, JavaScript/TypeScript and
 * Rust — so a single implementation serves every current and future analyzer.
 * Language-specific extras are opt-in via `CommentStringOptions`.
 */

export interface CommentStringOptions {
  /**
   * Enable C# verbatim (`@"..."`, `""`-escaped) and interpolated (`$"..."`)
   * string prefixes, including the combined `$@"`/`@$"` forms.
   */
  csharp?: boolean;
}

/** Scans a `\`-escaped literal from just after its opening quote. */
function scanQuoted(source: string, start: number, quote: string): number {
  const n = source.length;
  let j = start;
  while (j < n) {
    const ch = source[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) {
      return j + 1;
    }
    if (ch === '\n') {
      // A non-verbatim literal cannot span lines; stop so an unterminated
      // quote never blanks the remainder of the file.
      return j;
    }
    j += 1;
  }
  return n;
}

/** Scans a C# verbatim string (`@"..."`) where `""` is an escaped quote. */
function scanVerbatim(source: string, start: number): number {
  const n = source.length;
  let j = start;
  while (j < n) {
    if (source[j] === '"') {
      if (source[j + 1] === '"') {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return n;
}

export function blankCommentsAndStrings(
  source: string,
  options: CommentStringOptions = {},
): string {
  const n = source.length;
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) {
      if (source[k] !== '\n') {
        out[k] = ' ';
      }
    }
  };

  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') {
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) {
        j += 1;
      }
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }

    if (options.csharp && (c === '@' || c === '$')) {
      let j = i;
      let verbatim = false;
      while (j < n && (source[j] === '@' || source[j] === '$')) {
        if (source[j] === '@') {
          verbatim = true;
        }
        j += 1;
      }
      if (source[j] === '"') {
        const end = verbatim ? scanVerbatim(source, j + 1) : scanQuoted(source, j + 1, '"');
        blank(i, end);
        i = end;
        continue;
      }
      out[i] = c;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'") {
      const end = scanQuoted(source, i + 1, c);
      blank(i, end);
      i = end;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/** Replaces every match of `pattern` with an equal-length run of spaces. */
export function blankMatches(code: string, pattern: RegExp): string {
  return code.replace(pattern, (match) => ' '.repeat(match.length));
}
