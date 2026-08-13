/**
 * Splits a test file's unified diff into per-test-method segments so the PR
 * review can explain each changed test on its own. The change-graph builder
 * runs this over test-category nodes and the file-explanation prompt lists the
 * detected method names, so the model returns one explanation per method.
 *
 * Detection is deterministic and language-tolerant — it recognises the common
 * test-declaration shapes across the languages this tool reviews (JS/TS BDD
 * `it`/`test`/`describe`, Go `func TestXxx`, Python `def test_*`, and
 * C#/Java/xUnit method signatures). It also honours git's hunk section heading
 * (`@@ … @@ <enclosing function>`) so a hunk whose method signature is not part
 * of the visible context is still grouped under the right method.
 */

/** One method-scoped slice of a test file's unified diff. */
export interface TestMethodSegment {
  /** Detected test/method name, or null for the file preamble (imports/setup). */
  name: string | null;
  /** The slice of the unified diff belonging to this method, newline-joined. */
  diff: string;
  /** True when the segment contains at least one added or removed line. */
  changed: boolean;
}

/** Whether a diff line is an added/removed change (not a `+++`/`---` header). */
function isChangedLine(line: string): boolean {
  return (
    (line.startsWith('+') && !line.startsWith('+++')) ||
    (line.startsWith('-') && !line.startsWith('---'))
  );
}

/** Whether a line is unified-diff file metadata (not code we can segment on). */
function isFileMeta(line: string): boolean {
  return (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('+++') ||
    line.startsWith('---')
  );
}

/**
 * Detects the test/method name a single line of code declares, or null when the
 * line is not a recognised declaration. The line must already be stripped of any
 * leading unified-diff marker (`+`/`-`/space).
 */
export function detectTestMethodName(content: string): string | null {
  const trimmed = content.trim();
  // JS/TS BDD: it('name', …) / test("name", …) / describe(`name`, …), incl. .each/.skip.
  const bdd = /^(?:it|test|describe)(?:\.[A-Za-z]+)?(?:\([^)]*\))?\s*\(\s*(['"`])([\s\S]*?)\1/.exec(
    trimmed,
  );
  if (bdd) {
    return bdd[2].trim() || null;
  }
  // Go: func TestXxx(t *testing.T)
  const go = /^func\s+(Test[A-Za-z0-9_]*)\s*\(/.exec(trimmed);
  if (go) {
    return go[1];
  }
  // Python: def test_xxx(self)
  const py = /^def\s+(test[A-Za-z0-9_]*)\s*\(/i.exec(trimmed);
  if (py) {
    return py[1];
  }
  // C#/Java/xUnit method signature: optional attrs/annotations, a visibility
  // keyword, an optional static/async, a return type, then the method name.
  const method =
    /^(?:@[A-Za-z]\w*(?:\([^)]*\))?\s*)*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:[\w<>,.\[\]?]+\s+)+([A-Za-z_]\w*)\s*\(/.exec(
      trimmed,
    );
  if (method) {
    return method[1];
  }
  return null;
}

/** The enclosing-function heading git appends after a hunk header, or null. */
function hunkSectionName(line: string): string | null {
  const hunk = /^@@[^@]*@@\s?(.*)$/.exec(line);
  if (!hunk) {
    return null;
  }
  return detectTestMethodName(hunk[1]);
}

interface Draft {
  name: string | null;
  lines: string[];
  changed: boolean;
}

/**
 * Segments a test file's unified `diff` into ordered, method-scoped slices. The
 * leading slice (imports/setup, or a change with no detectable method) has a
 * null `name`. Returns an empty array for an empty diff.
 */
export function segmentTestMethods(diff: string): TestMethodSegment[] {
  const trimmed = diff.replace(/\n$/, '');
  if (trimmed.length === 0) {
    return [];
  }
  const segments: TestMethodSegment[] = [];
  let current: Draft | null = null;

  const flush = (): void => {
    if (current && current.lines.length > 0) {
      segments.push({
        name: current.name,
        diff: current.lines.join('\n'),
        changed: current.changed,
      });
    }
  };
  const start = (name: string | null, line: string): void => {
    flush();
    current = { name, lines: [line], changed: isChangedLine(line) };
  };
  const append = (line: string): void => {
    if (!current) {
      current = { name: null, lines: [], changed: false };
    }
    current.lines.push(line);
    if (isChangedLine(line)) {
      current.changed = true;
    }
  };

  for (const line of trimmed.split('\n')) {
    if (line.startsWith('@@')) {
      start(hunkSectionName(line), line);
      continue;
    }
    if (isFileMeta(line)) {
      append(line);
      continue;
    }
    const marker = line.charAt(0);
    const content =
      marker === '+' || marker === '-' || marker === ' ' ? line.slice(1) : line;
    const name = detectTestMethodName(content);
    if (name !== null) {
      start(name, line);
      continue;
    }
    append(line);
  }
  flush();
  return segments;
}

/**
 * The distinct, in-order method names a test diff touches with a change — the
 * boundaries the file-explanation prompt asks the model to explain one by one.
 * Preamble/unnamed and unchanged segments are excluded.
 */
export function changedTestMethodNames(diff: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const segment of segmentTestMethods(diff)) {
    if (segment.changed && segment.name && !seen.has(segment.name)) {
      seen.add(segment.name);
      names.push(segment.name);
    }
  }
  return names;
}
