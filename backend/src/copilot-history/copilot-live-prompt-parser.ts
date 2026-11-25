import type { LivePromptTurn } from './copilot-history-contract.js';

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

interface TrackedTurn {
  turn: LivePromptTurn;
  visible: boolean;
  turnId: string | null;
  parts: string[];
}

/** Correlate replies by native message IDs, even across queued user messages. */
export function parseLatestLivePrompt(
  tail: string,
  toVisible: (text: string) => string | null,
): LivePromptTurn | null {
  const turns: TrackedTurn[] = [];
  const byMessage = new Map<string, TrackedTurn>();
  const byTurn = new Map<string, TrackedTurn>();
  let current: TrackedTurn | null = null;
  let active: TrackedTurn | null = null;
  let activeId: string | null = null;
  const touch = (owner: TrackedTurn, timestamp: unknown) => {
    const at = validTimestamp(timestamp);
    if (at) owner.turn.lastActivityAt = at;
  };
  for (const line of tail.split('\n')) {
    const event = tryParse(line);
    if (!event) continue;
    const data = event.data;
    const id = typeof data?.turnId === 'string' ? data.turnId : null;
    const origin = typeof data?.originatingMessageId === 'string' ? byMessage.get(data.originatingMessageId) : undefined;
    if (event.type === 'user.message') {
      if (!data) continue;
      const text = toVisible(typeof data.content === 'string' ? data.content : '');
      current = {
        turn: { text: text ?? '', at: typeof event.timestamp === 'string' ? event.timestamp : '', response: null },
        visible: text !== null, turnId: id, parts: [],
      };
      touch(current, event.timestamp);
      if (active && active.turn.completedAt === undefined) current.turn.queued = true;
      else active = current;
      turns.push(current);
      if (typeof data.messageId === 'string') byMessage.set(data.messageId, current);
      if (id !== null) byTurn.set(id, current);
      continue;
    }
    if (event.type === 'assistant.turn_start' && id !== null) {
      const candidates = turns.filter((entry) => entry.turn.completedAt === undefined && entry.turnId === null);
      active = origin ?? byTurn.get(id) ?? (candidates.length === 1 ? candidates[0] : null);
      activeId = id;
      if (active) {
        active.turnId = id;
        byTurn.set(id, active);
        delete active.turn.queued;
        touch(active, event.timestamp);
      }
      continue;
    }
    if (event.type === 'assistant.message') {
      if (!origin) continue;
      active = origin;
      delete origin.turn.queued;
      if (origin.turnId === null && activeId !== null) {
        origin.turnId = activeId;
        byTurn.set(activeId, origin);
      }
      const content = typeof data!.content === 'string' ? data!.content.trim() : '';
      if (content) origin.parts.push(content);
      touch(origin, event.timestamp);
      continue;
    }
    if (event.type === 'assistant.turn_end') {
      const owner = id === null ? undefined : byTurn.get(id);
      if (owner) {
        owner.turn.completedAt = validTimestamp(event.timestamp);
        delete owner.turn.queued;
        touch(owner, event.timestamp);
      }
      if (id === activeId) activeId = null;
      continue;
    }
    const owner = id !== null ? byTurn.get(id) : active ?? current;
    if (owner) touch(owner, event.timestamp);
  }
  const visible = turns.filter((entry) => entry.visible).slice(-100).map(({ turn, parts }) => ({
    ...turn, response: parts.length ? parts.join('\n\n') : null,
  }));
  const latest = visible.pop();
  return latest ? { ...latest, ...(visible.length ? { preceding: visible } : {}) } : null;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function tryParse(line: string): ParsedEvent | null {
  try {
    const value = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as ParsedEvent) : null;
  } catch {
    return null;
  }
}
