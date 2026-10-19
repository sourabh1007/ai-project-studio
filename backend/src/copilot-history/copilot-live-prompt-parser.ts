import type { LivePromptTurn } from './copilot-history-contract.js';

/**
 * Parses the tail of a CLI `events.jsonl` log into the latest in-flight turn.
 *
 * The CLI appends one JSON object per line. The newest genuine user prompt is
 * the last `user.message` event whose mapped visible text is non-null. Mapping
 * is delegated to `toVisible`, which hides app-injected prompts yet unwraps a
 * launch prompt's embedded request, so the parser stays decoupled from the
 * reader's sentinel list. Each assistant message for that turn carries an
 * `originatingMessageId` equal to the user message's `messageId`, so the
 * reply-so-far is the ordered concatenation of those assistant messages'
 * `content`. Lines that fail to parse (including a partial first line left by a
 * byte-bounded tail read) are skipped.
 */
export function parseLatestLivePrompt(
  tail: string,
  toVisible: (text: string) => string | null,
): LivePromptTurn | null {
  const events: ParsedEvent[] = [];
  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = tryParse(trimmed);
    if (parsed) {
      events.push(parsed);
    }
  }

  let userIndex = -1;
  let foundText = '';
  let foundAt = '';
  let foundMessageId: string | null = null;
  let turnId: string | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'user.message') {
      continue;
    }
    const data = event.data;
    if (!data) {
      continue;
    }
    const content = typeof data.content === 'string' ? data.content : '';
    const visible = toVisible(content);
    if (visible !== null) {
      userIndex = i;
      foundText = visible;
      foundAt = typeof event.timestamp === 'string' ? event.timestamp : '';
      foundMessageId = typeof data.messageId === 'string' ? data.messageId : null;
      turnId = typeof data.turnId === 'string' ? data.turnId : null;
      break;
    }
  }
  if (userIndex < 0) {
    return null;
  }

  const parts: string[] = [];
  let completedAt: string | null | undefined;
  for (let i = userIndex + 1; i < events.length; i += 1) {
    const event = events[i];
    // A hidden/injected user turn must not complete the preceding visible turn.
    if (event.type === 'user.message') {
      break;
    }
    const data = event.data;
    if (event.type === 'assistant.turn_start' && turnId === null && typeof data?.turnId === 'string') {
      turnId = data.turnId;
    }
    if (event.type === 'assistant.turn_end' && turnId !== null && data?.turnId === turnId) {
      completedAt = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))
        ? event.timestamp
        : null;
    }
    if (event.type !== 'assistant.message' || foundMessageId === null ||
        !data || data.originatingMessageId !== foundMessageId) {
      continue;
    }
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    if (content.length > 0) {
      parts.push(content);
    }
  }
  const response = parts.join('\n\n');

  return {
    text: foundText, at: foundAt, response: response.length > 0 ? response : null,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

interface ParsedEvent {
  type?: unknown;
  timestamp?: unknown;
  data?: {
    content?: unknown;
    messageId?: unknown;
    originatingMessageId?: unknown;
    turnId?: unknown;
  };
}

function tryParse(line: string): ParsedEvent | null {
  try {
    const value = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as ParsedEvent) : null;
  } catch {
    return null;
  }
}
