import type {
  ChangeGraphAnnotations,
  ChangeGraphAnnotationNote,
} from './pr-review-contract.js';

/** The fenced-code language tag the model uses to carry diagram annotations. */
const FENCE_TAG = 'pr-graph';

/** Longest note text kept; anything past this is truncated with an ellipsis. */
const MAX_NOTE_CHARS = 140;

/** Upper bounds so a runaway answer can never flood the diagram with overlay. */
const MAX_HIGHLIGHTS = 40;
const MAX_FLOW = 40;
const MAX_NOTES = 40;

/**
 * Matches a ```` ```pr-graph … ``` ```` fenced block (case-insensitive tag,
 * optional surrounding whitespace). The body is captured so it can be parsed as
 * JSON and the whole block stripped from the prose the reviewer sees.
 */
const FENCE_RE = new RegExp(
  '```[ \\t]*' + FENCE_TAG + '[ \\t]*\\r?\\n([\\s\\S]*?)```',
  'i',
);

/** Clamp a note to a sensible length so one note cannot dominate the canvas. */
function clampNote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_NOTE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…`;
}

/** Distinct, order-preserving path list restricted to real graph nodes. */
function validPathList(
  value: unknown,
  valid: ReadonlySet<string>,
  cap: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const path = entry.trim();
    if (!valid.has(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

/** Notes whose path is a real node and whose text is non-empty, deduped by path. */
function validNotes(
  value: unknown,
  valid: ReadonlySet<string>,
): ChangeGraphAnnotationNote[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChangeGraphAnnotationNote[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const path = (entry as { path?: unknown }).path;
    const text = (entry as { text?: unknown }).text;
    if (typeof path !== 'string' || typeof text !== 'string') {
      continue;
    }
    const key = path.trim();
    const note = clampNote(text);
    if (!valid.has(key) || note.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ path: key, text: note });
    if (out.length >= MAX_NOTES) {
      break;
    }
  }
  return out;
}

/**
 * Splits the chat answer into the prose the reviewer reads and an optional
 * diagram overlay. The model may append a single ```` ```pr-graph``` ```` block
 * whose JSON body names nodes to spotlight (`highlight`), an ordered flow to
 * trace (`focusFlow`) and short notes to pin (`notes`). The block is always
 * stripped from the prose (so raw JSON is never shown), every referenced path is
 * validated against the real graph, and the overlay is dropped entirely when it
 * ends up empty or the JSON is malformed.
 */
export function parseGraphAnnotations(
  raw: string,
  validPaths: ReadonlySet<string>,
): { answer: string; annotations: ChangeGraphAnnotations | null } {
  const match = FENCE_RE.exec(raw);
  if (!match) {
    return { answer: raw.trim(), annotations: null };
  }
  const answer = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length))
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { answer, annotations: null };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { answer, annotations: null };
  }

  const source = parsed as {
    highlight?: unknown;
    focusFlow?: unknown;
    notes?: unknown;
  };
  const highlight = validPathList(source.highlight, validPaths, MAX_HIGHLIGHTS);
  const focusFlow = validPathList(source.focusFlow, validPaths, MAX_FLOW);
  const notes = validNotes(source.notes, validPaths);
  if (highlight.length === 0 && focusFlow.length === 0 && notes.length === 0) {
    return { answer, annotations: null };
  }
  return { answer, annotations: { highlight, focusFlow, notes } };
}
