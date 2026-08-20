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
  CheckStatus,
  FindingSeverity,
  PerspectiveCheck,
  RationalePoint,
  ReviewBoardRatingChange,
  ReviewEvidence,
  ReviewFinding,
  ReviewRisk,
  ReviewStatus,
} from './review-board-contract.js';

const SEVERITIES: readonly FindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'suggestion',
];

const CHECK_STATUSES: readonly CheckStatus[] = ['pass', 'concern', 'na'];

/** The rating verdicts the review agent may set for a perspective. */
const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'not-started',
  'needs-review',
  'warning',
  'blocked',
  'approved',
  'not-applicable',
];

/** The risk bands the review agent may set for a perspective. */
const REVIEW_RISKS: readonly ReviewRisk[] = [
  'low',
  'medium',
  'high',
  'critical',
  'unknown',
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

/** Coerce an unknown check status into a valid one, defaulting to 'pass'. */
function toCheckStatus(value: unknown): CheckStatus {
  return CHECK_STATUSES.includes(value as CheckStatus)
    ? (value as CheckStatus)
    : 'pass';
}

/** Build one validated line-item check from a raw record, or null. */
function toCheck(raw: unknown): PerspectiveCheck | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isText(record.item) || !isText(record.finding)) return null;
  return {
    item: record.item.trim(),
    finding: record.finding.trim(),
    status: toCheckStatus(record.status),
  };
}

/** Parse the optional `checks` array from a perspective record. */
function parseChecks(value: unknown): PerspectiveCheck[] {
  if (!Array.isArray(value)) return [];
  const checks: PerspectiveCheck[] = [];
  value.forEach((raw) => {
    const check = toCheck(raw);
    if (check) checks.push(check);
  });
  return checks;
}

/** Build one validated rationale point from a raw record, or null. */
function toRationalePoint(raw: unknown): RationalePoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isText(record.label) || !isText(record.detail)) return null;
  return { label: record.label.trim(), detail: record.detail.trim() };
}

/** Parse the optional `rationale` array from a perspective record. */
function parseRationale(value: unknown): RationalePoint[] {
  if (!Array.isArray(value)) return [];
  const points: RationalePoint[] = [];
  value.forEach((raw) => {
    const point = toRationalePoint(raw);
    if (point) points.push(point);
  });
  return points;
}

/** The parsed outcome of a single-perspective AI review. */
export interface ParsedPerspectiveAnalysis {
  findings: ReviewFinding[];
  skipped: boolean;
  skipReason: string | null;
  /** What the reviewer checked to justify the rating, or null when omitted. */
  summary: string | null;
  /** Evidence-backed labeled narrative justifying the rating. */
  rationale: RationalePoint[];
  /** Line-by-line audit trail of what was inspected and each outcome. */
  checks: PerspectiveCheck[];
}

/**
 * Parse the model's single-perspective response: a JSON object with an optional
 * `skipped`/`reason`, a `summary` of what was checked, a `rationale` narrative,
 * a `checks` audit trail, and a `findings` array. Totally defensive — a
 * malformed completion yields no findings and no skip, so the perspective
 * simply shows its deterministic result. All findings are attributed to
 * `perspectiveId`.
 */
export function parsePerspectiveAnalysis(
  text: string,
  perspectiveId: string,
): ParsedPerspectiveAnalysis {
  const record = extractJsonObject(text);
  if (record === null) {
    return {
      findings: [],
      skipped: false,
      skipReason: null,
      summary: null,
      rationale: [],
      checks: [],
    };
  }
  const summary = isText(record.summary) ? record.summary.trim() : null;
  const rationale = parseRationale(record.rationale);
  const checks = parseChecks(record.checks);
  if (record.skipped === true) {
    const skipReason = isText(record.reason)
      ? record.reason.trim()
      : 'The reviewer judged this perspective not applicable to the change.';
    return {
      findings: [],
      skipped: true,
      skipReason,
      summary,
      rationale,
      checks,
    };
  }
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  const findings: ReviewFinding[] = [];
  rawFindings.forEach((raw, index) => {
    const finding = toFinding(raw, perspectiveId, index);
    if (finding) findings.push(finding);
  });
  return {
    findings,
    skipped: false,
    skipReason: null,
    summary,
    rationale,
    checks,
  };
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

/** The parsed outcome of a review-agent chat turn. */
export interface ParsedChatReply {
  answer: string;
  ratingChange: ReviewBoardRatingChange | null;
}

/** Extract the FENCED ```json object from an agent reply, or null. Unlike the
 * lenient object extractor, this only trusts an explicit fenced block so a
 * rating change can never be conjured from stray braces in prose. */
function extractFencedObject(text: string): {
  record: Record<string, unknown>;
  block: string;
} | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (!fenced) return null;
  const candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const record = JSON.parse(candidate.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    return { record, block: fenced[0] };
  } catch {
    return null;
  }
}

/**
 * Parse a review-agent chat reply. The agent answers in prose and, ONLY when
 * the discussion convinced it to change the focused perspective's rating,
 * appends a single fenced ```json object describing the new verdict. This is
 * totally defensive: a plain-prose reply (or any malformed/partial block, an
 * unknown status/risk, or a missing justification) yields the answer with a
 * null `ratingChange`, so a rating never changes without a complete, valid
 * proposal — and never at all for a whole-board (perspectiveId === null) chat.
 */
export function parseChatReply(
  text: string,
  perspectiveId: string | null,
): ParsedChatReply {
  const trimmed = text.trim();
  if (perspectiveId === null) {
    return { answer: trimmed, ratingChange: null };
  }
  const extracted = extractFencedObject(text);
  if (extracted === null) {
    return { answer: trimmed, ratingChange: null };
  }
  const { record, block } = extracted;
  const status = record.status;
  const risk = record.risk;
  const summary = record.summary;
  const justification = record.justification;
  const rationale = parseRationale(record.rationale);
  const valid =
    REVIEW_STATUSES.includes(status as ReviewStatus) &&
    REVIEW_RISKS.includes(risk as ReviewRisk) &&
    isText(summary) &&
    isText(justification) &&
    rationale.length > 0;
  if (!valid) {
    return { answer: trimmed, ratingChange: null };
  }
  // Strip the machine-readable block from the human-facing answer; fall back to
  // a short confirmation when the reply was nothing but the block.
  const answer =
    text.replace(block, '').trim() ||
    'Updated the rating for this perspective based on our discussion.';
  return {
    answer,
    ratingChange: {
      perspectiveId,
      status: status as ReviewStatus,
      risk: risk as ReviewRisk,
      summary: (summary as string).trim(),
      rationale,
      justification: (justification as string).trim(),
    },
  };
}
