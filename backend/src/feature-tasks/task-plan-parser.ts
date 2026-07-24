import type { FeatureTasksConfig } from './config.js';
import type { TaskDraft } from './feature-tasks-contract.js';

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

/** Parses a single plan item (string or object) into a task draft. */
function toDraft(item: unknown, config: FeatureTasksConfig): TaskDraft | null {
  if (typeof item === 'string') {
    const title = item.trim();
    return title.length > 0 ? { title, detail: '' } : null;
  }
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    const title = firstString(record, config.titleKeys);
    if (title.length === 0) {
      return null;
    }
    return { title, detail: firstString(record, config.detailKeys) };
  }
  return null;
}

/** Extracts the first top-level JSON array substring from arbitrary text. */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function parseArray(text: string): unknown[] | null {
  const attempts = [text];
  const extracted = extractJsonArray(text);
  if (extracted !== null && extracted !== text) {
    attempts.push(extracted);
  }
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Tolerantly parses an AI-generated task plan into ordered task drafts. Accepts
 * a strict JSON array, JSON embedded in surrounding prose, or arrays of plain
 * strings. Titles are trimmed and clamped, blank entries dropped, and the list
 * is capped at `config.maxTasks`. Returns an empty array when nothing parses so
 * generation is always safe and unit-testable.
 */
export function parseTaskPlan(
  text: string,
  config: FeatureTasksConfig,
): TaskDraft[] {
  const items = parseArray(text.trim());
  if (!items) {
    return [];
  }
  const drafts: TaskDraft[] = [];
  for (const item of items) {
    const draft = toDraft(item, config);
    if (draft) {
      drafts.push({
        title: draft.title.slice(0, config.maxTitleLength),
        detail: draft.detail,
      });
    }
    if (drafts.length >= config.maxTasks) {
      break;
    }
  }
  return drafts;
}
