/**
 * Pure parser turning the AI findings response into validated
 * {@link ReviewFinding}s. The model is asked for a fenced JSON array, but real
 * responses drift — extra prose, missing fences, unknown perspective ids,
 * out-of-range confidences. Everything here is defensive and total so the
 * board never crashes on a malformed completion and the 100% gate can cover
 * every rejection branch.
 */

import { statusForSeverity } from './review-board-builder.js';
import type {
  FindingSeverity,
  ReviewEvidence,
  ReviewFinding,
} from './review-board-contract.js';

const SEVERITIES: readonly FindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'suggestion',
];

/** Extract the JSON array from a completion, tolerating fences and prose. */
function extractJsonArray(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Extract the JSON object from a completion, tolerating fences and prose. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** True when `value` is a non-empty, non-blank string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Clamp an unknown confidence into [0, 1], defaulting to 0.6. */
function toConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.6;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Parse and validate one evidence entry, or null when unusable. */
function toEvidence(raw: unknown): ReviewEvidence | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isText(record.source) || !isText(record.reason)) return null;
  return {
    source: record.source.trim(),
    reason: record.reason.trim(),
    confidence: toConfidence(record.confidence),
    direct: false,
  };
}

/** Coerce an unknown severity into a valid one, defaulting to 'medium'. */
function toSeverity(value: unknown): FindingSeverity {
  return SEVERITIES.includes(value as FindingSeverity)
    ? (value as FindingSeverity)
    : 'medium';
}

/** Build one validated finding from a raw record, or null when unusable. */
function toFinding(
  raw: unknown,
  perspectiveId: string,
  index: number,
): ReviewFinding | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isText(record.title) || !isText(record.detail)) return null;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence
        .map(toEvidence)
        .filter((e): e is ReviewEvidence => e !== null)
    : [];
  if (evidence.length === 0) return null;
  const severity = toSeverity(record.severity);
  return {
    id: `${perspectiveId}/ai-${index}`,
    perspectiveId,
    title: record.title.trim(),
    detail: record.detail.trim(),
    severity,
    status: statusForSeverity(severity),
    evidence,
  };
}

/**
 * Parse the model's findings response. Only findings whose `perspectiveId` is
 * in `validPerspectiveIds` and that carry a title, detail and at least one
 * usable evidence entry are kept. Ids are made unique and stable per index.
 */
export function parseAiFindings(
  text: string,
  validPerspectiveIds: readonly string[],
): ReviewFinding[] {
  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) return [];
  const valid = new Set(validPerspectiveIds);
  const findings: ReviewFinding[] = [];
  parsed.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const record = raw as Record<string, unknown>;
    const perspectiveId = record.perspectiveId;
    if (typeof perspectiveId !== 'string' || !valid.has(perspectiveId)) return;
    const finding = toFinding(record, perspectiveId, index);
    if (finding) findings.push(finding);
  });
  return findings;
}

/** The parsed outcome of a single-perspective AI review. */
export interface ParsedPerspectiveAnalysis {
  findings: ReviewFinding[];
  skipped: boolean;
  skipReason: string | null;
}

/**
 * Parse the model's single-perspective response: a JSON object with an optional
 * `skipped`/`reason` and a `findings` array. Totally defensive — a malformed
 * completion yields no findings and no skip, so the perspective simply shows
 * its deterministic result. All findings are attributed to `perspectiveId`.
 */
export function parsePerspectiveAnalysis(
  text: string,
  perspectiveId: string,
): ParsedPerspectiveAnalysis {
  const record = extractJsonObject(text);
  if (record === null) return { findings: [], skipped: false, skipReason: null };
  if (record.skipped === true) {
    const skipReason = isText(record.reason)
      ? record.reason.trim()
      : 'The reviewer judged this perspective not applicable to the change.';
    return { findings: [], skipped: true, skipReason };
  }
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  const findings: ReviewFinding[] = [];
  rawFindings.forEach((raw, index) => {
    const finding = toFinding(raw, perspectiveId, index);
    if (finding) findings.push(finding);
  });
  return { findings, skipped: false, skipReason: null };
}

/**
 * Cap the number of AI findings kept per perspective. The model can be
 * verbose; the board keeps the first `max` per perspective (highest-signal
 * first is the model's job) so a perspective never floods the UI.
 */
export function capPerspectiveFindings(
  findings: ReviewFinding[],
  max: number,
): ReviewFinding[] {
  const counts = new Map<string, number>();
  const kept: ReviewFinding[] = [];
  for (const finding of findings) {
    const used = counts.get(finding.perspectiveId) ?? 0;
    if (used >= max) continue;
    counts.set(finding.perspectiveId, used + 1);
    kept.push(finding);
  }
  return kept;
}
