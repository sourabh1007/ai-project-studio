import type { Transcript } from '../session/transcript-capture.js';
import type { SummarizerConfig } from './config.js';

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

/**
 * Clamps the summary to the configured maximum length so summaries stay short,
 * appending an ellipsis when truncated. Whitespace-only remainders are trimmed.
 */
function clampSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Extracts the assistant's summary text from a meta session transcript. The
 * Copilot CLI emits JSON when `--output-format json` is set, so we first try to
 * read a configured response key from parsed JSON, then fall back to the raw
 * captured stdout. Returns an empty string when nothing usable was captured.
 * The result is clamped to `config.maxSummaryChars` to keep summaries short.
 */
export function extractSummaryText(
  transcript: Transcript | null,
  config: SummarizerConfig,
): string {
  return clampSummary(extractRawSummaryText(transcript, config), config.maxSummaryChars);
}

function extractRawSummaryText(
  transcript: Transcript | null,
  config: SummarizerConfig,
): string {
  if (!transcript) {
    return '';
  }
  const raw = transcript.stdout.join('\n').trim();
  if (raw.length === 0) {
    return '';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return raw;
  }

  const record = parsed as Record<string, unknown>;
  for (const key of config.responseTextKeys) {
    const found = readString(record, key);
    if (found !== null) {
      return found;
    }
  }
  return raw;
}
