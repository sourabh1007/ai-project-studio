/** Longest a single activity line may be before it is elided. */
const MAX_ACTIVITY_CHARS = 160;

function clip(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_ACTIVITY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_ACTIVITY_CHARS - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** A short label for the tool a `tool.*` event refers to, when discoverable. */
function toolLabel(data: Record<string, unknown> | null): string {
  if (!data) {
    return '';
  }
  const name = firstString(data, ['name', 'tool', 'toolName', 'title']);
  return name ? ` ${name}` : '';
}

/**
 * Turns one raw metasession output line into a concise, human-readable activity
 * entry — or null when the line carries nothing worth showing (empty lines,
 * streaming deltas that would flood the log, telemetry with no meaning to a
 * reader). The Copilot CLI emits NDJSON events (`{ type, data }`) plus the odd
 * plain diagnostic line; both are surfaced so the PR review page can show what a
 * step's metasession is actually doing rather than an opaque "Analyzing…".
 */
export function describeMetaActivity(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return `· ${clip(trimmed)}`;
  }

  const record = asRecord(parsed);
  if (!record || typeof record.type !== 'string') {
    return `· ${clip(trimmed)}`;
  }

  const type = record.type;
  const data = asRecord(record.data);

  // Streaming token deltas would flood the log; the final message is enough.
  if (
    type === 'assistant.message_delta' ||
    type === 'assistant.message.delta' ||
    type === 'message.delta'
  ) {
    return null;
  }

  if (type === 'assistant.message') {
    const content = data
      ? firstString(data, ['content', 'message', 'delta'])
      : null;
    return content ? `💬 ${clip(content)}` : '💬 assistant responded';
  }

  if (type === 'session.error') {
    const message = data
      ? firstString(data, ['message', 'error', 'content'])
      : null;
    return `⚠ ${clip(message ?? 'session error')}`;
  }

  if (type.startsWith('tool.')) {
    const verb = type.includes('start')
      ? 'running'
      : type.includes('complete') || type.includes('end')
        ? 'finished'
        : 'tool';
    return `🔧 ${verb}${toolLabel(data)}`;
  }

  if (type.startsWith('reasoning')) {
    const content = data ? firstString(data, ['content', 'text']) : null;
    return content ? `🧠 ${clip(content)}` : null;
  }

  // Any other typed event: show the event type so the log still reflects motion.
  return `· ${clip(type)}`;
}
