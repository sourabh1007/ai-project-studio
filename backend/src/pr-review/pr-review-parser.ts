/** Canonical section headers the model is asked to emit. */
export const PR_REVIEW_SUMMARY_HEADING = 'PR Summary';
export const PR_REVIEW_CORE_HEADING = 'Core Analysis';

const SUMMARY_HEADER = /^[ \t]{0,3}#{1,6}[ \t]*(?:pr[ \t]+)?summary[ \t]*$/im;
const CORE_HEADER = /^[ \t]{0,3}#{1,6}[ \t]*core[ \t]+analysis[ \t]*$/im;

/** A parsed review: the two sections the panel renders. */
export interface ParsedPrReview {
  summary: string | null;
  coreAnalysis: string | null;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Splits the model's response into the summary and core-analysis sections.
 * Tolerant of a missing core header (everything becomes the summary) and of a
 * missing summary header (the text before the core header is the summary).
 */
export function parsePrReview(text: string): ParsedPrReview {
  const trimmed = text.trim();
  const core = CORE_HEADER.exec(trimmed);
  if (!core) {
    return {
      summary: blankToNull(trimmed.replace(SUMMARY_HEADER, '')),
      coreAnalysis: null,
    };
  }
  const before = trimmed.slice(0, core.index).replace(SUMMARY_HEADER, '');
  const after = trimmed.slice(core.index + core[0].length);
  return {
    summary: blankToNull(before),
    coreAnalysis: blankToNull(after),
  };
}
