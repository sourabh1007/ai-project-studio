import type { ChangeGraphCategory } from './pr-review-contract.js';

/**
 * Parsers for the PR-review analysis steps. The problem-statement metasession
 * emits a small fixed Markdown contract; the lazy per-file explanation emits a
 * single JSON object. These functions turn that output into the structured
 * fields the review page renders, tolerant of missing headers and code fences so
 * a well-formed body is never discarded. (The change graph itself is built
 * deterministically by `change-graph-builder`, not parsed from AI output.)
 */

/** Canonical section header the problem-statement metasession emits. */
export const PROBLEM_STATEMENT_HEADING = 'Problem Statement';

/** Sentinel the problem-statement step emits when the description is too thin. */
export const INSUFFICIENT_MARKER = 'INSUFFICIENT';

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Strips a single leading `# Heading` line matching `heading` (case-insensitive). */
function stripHeading(text: string, heading: string): string {
  const re = new RegExp(
    `^[ \\t]{0,3}#{1,6}[ \\t]*${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`,
    'im',
  );
  return text.replace(re, '');
}

/** A parsed problem statement plus whether the description was sufficient. */
export interface ParsedProblemStatement {
  content: string | null;
  sufficient: boolean;
}

/**
 * Parses the problem-statement response. When the model reports the description
 * was too thin it prefixes the body with `INSUFFICIENT:`; that becomes
 * `sufficient: false` and the explanation is kept as the content so the UI can
 * show *why* rather than inventing a problem.
 */
export function parseProblemStatement(text: string): ParsedProblemStatement {
  const body = stripHeading(text.trim(), PROBLEM_STATEMENT_HEADING).trim();
  const marker = new RegExp(`^${INSUFFICIENT_MARKER}\\s*[:.-]?\\s*`, 'i');
  if (marker.test(body)) {
    return { content: blankToNull(body.replace(marker, '')), sufficient: false };
  }
  return { content: blankToNull(body), sufficient: true };
}

/** Coerces an unknown to a trimmed string, or '' when not string-like. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Coerces an unknown into a list of non-empty finding strings. Accepts an array
 * of strings (the expected shape), tolerates a single string (splitting it into
 * lines so a model that ignores the array contract still yields findings), and
 * returns an empty list for anything else — the well-formed "no issues" result.
 */
function asStringArray(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\n')
      : [];
  return raw
    .map((entry) => asString(entry).replace(/^[-*\u2022]\s*/, '').trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Extracts the first JSON object from model output, tolerating ```json code
 * fences and surrounding prose. Returns null when no object can be parsed.
 */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Path patterns that mark a file as a test rather than production code. Covers
 * the common conventions across the languages this tool reviews (xUnit/NUnit
 * `*Test(s).cs`, JS/TS `*.test|spec.*` and `__tests__`, Go `*_test.go`, Python
 * `test_*`/`*_test.py`, and files living under a `test`/`tests` directory).
 */
const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])__tests__[\\/]/i,
  /(^|[\\/])tests?[\\/]/i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /tests?\.cs$/i,
  /_test\.go$/i,
  /(^|[\\/])test_[^\\/]+\.py$/i,
  /_test\.py$/i,
];

/** Classifies a changed file as production code or a test from its path. */
export function classifyCategory(path: string): ChangeGraphCategory {
  return TEST_PATH_PATTERNS.some((re) => re.test(path)) ? 'test' : 'code';
}

/** Placeholder shown for a file's description until it is explained on demand. */
export const UNEXPLAINED_WHAT_IT_DOES = 'No description was produced for this file.';

/** Placeholder shown for a file's change summary until it is explained on demand. */
export const UNEXPLAINED_WHAT_CHANGED = 'No change summary was produced.';

/**
 * Whether a change-graph file already carries a real, on-demand English
 * explanation (rather than the placeholders written when the graph is built).
 * Used to serve the lazy per-file explanation from cache instead of re-running a
 * metasession for a file whose description is already known. The syntactic
 * review is intentionally not consulted: a clean file legitimately has an empty
 * review, and all three fields are always produced together in one metasession.
 */
export function isFileExplained(file: {
  whatItDoes: string;
  whatChanged: string;
}): boolean {
  return (
    file.whatItDoes.trim().length > 0 &&
    file.whatItDoes !== UNEXPLAINED_WHAT_IT_DOES &&
    file.whatChanged.trim().length > 0 &&
    file.whatChanged !== UNEXPLAINED_WHAT_CHANGED
  );
}

/** A per-file English explanation produced on demand from that file's diff. */
export interface ParsedFileExplanation {
  whatItDoes: string;
  whatChanged: string;
  /**
   * Syntactic review findings, one entry per issue. Empty when the change is
   * clean and no issues were found.
   */
  review: string[];
}

/**
 * Parses the lazy per-file explanation response — a single JSON object with
 * `whatItDoes`, `whatChanged` and a `review` list of syntactic findings. Falls
 * back to the unexplained placeholders for the text fields the model omitted and
 * to an empty finding list, so the caller always gets a well-formed result.
 */
export function parseFileExplanation(text: string): ParsedFileExplanation {
  const raw = extractJsonObject(text) as
    | { whatItDoes?: unknown; whatChanged?: unknown; review?: unknown }
    | null;
  return {
    whatItDoes: asString(raw?.whatItDoes) || UNEXPLAINED_WHAT_IT_DOES,
    whatChanged: asString(raw?.whatChanged) || UNEXPLAINED_WHAT_CHANGED,
    review: asStringArray(raw?.review),
  };
}

