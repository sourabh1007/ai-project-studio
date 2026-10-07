import type { LivePromptTurn } from './copilot-history-contract.js';

/**
 * Parses the tail of a CLI `events.jsonl` log into the latest in-flight turn.
 *
 * The CLI appends one JSON object per line. The newest genuine user prompt is
 * the last `user.message` event whose text is non-empty and not an app-injected
 * prompt. Each assistant message for that turn carries an `originatingMessageId`
 * equal to the user message's `messageId`, so the reply-so-far is the ordered
 * concatenation of those assistant messages' `content`. Lines that fail to parse
 * (including a partial first line left by a byte-bounded tail read) are skipped.
 *
 * `isInjected` is injected so the parser stays decoupled from the reader's
 * sentinel list while still filtering bootstrap/metasession prompts.
 */
export function parseLatestLivePrompt(
  tail: string,
  isInjected: (text: string) => boolean,
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
    if (content.trim().length > 0 && !isInjected(content.trim())) {
      userIndex = i;
      foundText = content;
      foundAt = typeof event.timestamp === 'string' ? event.timestamp : '';
      foundMessageId = typeof data.messageId === 'string' ? data.messageId : null;
      break;
    }
  }
  if (userIndex < 0) {
    return null;
  }

  const parts: string[] = [];
  if (foundMessageId !== null) {
    for (let i = userIndex + 1; i < events.length; i += 1) {
      const event = events[i];
      if (event.type !== 'assistant.message') {
        continue;
      }
      const data = event.data;
      if (!data || data.originatingMessageId !== foundMessageId) {
        continue;
      }
      const content = typeof data.content === 'string' ? data.content.trim() : '';
      if (content.length > 0) {
        parts.push(content);
      }
    }
  }
  const response = parts.join('\n\n');

  return { text: foundText, at: foundAt, response: response.length > 0 ? response : null };
}

interface ParsedEvent {
  type?: unknown;
  timestamp?: unknown;
  data?: {
    content?: unknown;
    messageId?: unknown;
    originatingMessageId?: unknown;
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
