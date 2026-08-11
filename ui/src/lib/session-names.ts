/**
 * Client-side store for user-editable session display names.
 *
 * Session identity in the backend is a UUID; the friendly, editable label
 * ("Session #1", or a custom name) is a presentation concern kept locally so
 * it can be renamed instantly without a backend round-trip or schema change.
 */

/** Minimal storage contract satisfied by `window.localStorage`. */
export interface SessionNameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Default key under which the id → custom-name map is persisted. */
export const SESSION_NAMES_KEY = 'cw.session-names';

export interface SessionNameStore {
  /** Returns the full map of session id → custom name. */
  all(): Record<string, string>;
  /** Sets a custom name; a blank/whitespace value clears it (reverts to default). */
  set(id: string, name: string): void;
  /** Removes any custom name for the session (reverts to default). */
  remove(id: string): void;
}

/** Creates a session-name store backed by the given storage. */
export function createSessionNameStore(
  storage: SessionNameStorage,
  key: string = SESSION_NAMES_KEY,
): SessionNameStore {
  function read(): Record<string, string> {
    const raw = storage.getItem(key);
    if (!raw) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      const result: Record<string, string> = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          result[id] = value;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  function write(map: Record<string, string>): void {
    storage.setItem(key, JSON.stringify(map));
  }

  return {
    all: read,
    set(id, name) {
      const trimmed = name.trim();
      const map = read();
      if (trimmed === '') {
        delete map[id];
      } else {
        map[id] = trimmed;
      }
      write(map);
    },
    remove(id) {
      const map = read();
      delete map[id];
      write(map);
    },
  };
}

/** The default label for a session at the given 1-based ordinal position. */
export function defaultSessionLabel(ordinal: number): string {
  return `Session #${ordinal}`;
}

/** Resolves the display name: a custom name when set, otherwise the default label. */
export function sessionDisplayName(
  custom: string | null | undefined,
  ordinal: number,
): string {
  const trimmed = custom?.trim();
  return trimmed ? trimmed : defaultSessionLabel(ordinal);
}

/** Boilerplate prefixes stripped from a launch prompt when deriving a title. */
const PROMPT_TITLE_NOISE = /^(please\s+|kindly\s+|can you\s+|could you\s+)/i;

/**
 * A human, "what was done" title for a session. Prefers the user's custom name;
 * otherwise derives a concise title from the session's launch prompt or, for
 * prompt-less terminal/metasessions, a CLI-history work title. Falls back to
 * "Session #N" only when there is no work text to summarise.
 */
export function sessionWorkTitle(
  custom: string | null | undefined,
  prompt: string | null | undefined,
  workTitle: string | null | undefined,
  ordinal: number,
  maxLength = 64,
): string {
  const trimmedCustom = custom?.trim();
  if (trimmedCustom) {
    return trimmedCustom;
  }
  const firstLine = [prompt, workTitle]
    .flatMap((value) => (value ?? '').split('\n'))
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return defaultSessionLabel(ordinal);
  }
  const cleaned = firstLine
    .replace(PROMPT_TITLE_NOISE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (title.length <= maxLength) {
    return title;
  }
  return `${title.slice(0, maxLength - 1).trimEnd()}…`;
}
