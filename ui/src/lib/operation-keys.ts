import { ApiError } from './api';
import { pushOperationNotice } from './operation-notices';

/**
 * Durable, opaque client operation keys. A create that may have committed but
 * whose response was lost (network drop, page or window reload) is retried
 * with the SAME key so the backend replays the original result instead of
 * creating a duplicate. Only opaque keys and a short fingerprint hash are
 * stored: never prompts, titles or other request content.
 */

export const OPERATION_KEYS_STORAGE_KEY = 'aps.operationKeys.v1';

/**
 * Every stored key is unresolved (its create may have committed), so none is ever
 * expired or evicted: dropping one could duplicate the create. A key leaves the
 * store only on a confirmed result, a definite rejection or an explicitly edited
 * intent; at capacity new intents are refused instead.
 */
export const DEFAULT_OPERATION_KEY_CAPACITY = 32;

const KEY_PATTERN = /^[A-Za-z0-9._:~-]{8,128}$/;
const FIELD_PATTERN = /^[A-Za-z0-9._:~-]{1,128}$/;

interface Entry {
  group: string;
  fingerprint: string;
  stage: string;
  key: string;
  at: number;
}

/** Thrown when protection cannot be stored, so the create must not be sent. */
export class OperationKeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationKeyStoreError';
  }
}

export interface OperationKeyStoreOptions {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
  newKey?: () => string;
  capacity?: number;
}

export interface OperationKeyStore {
  /**
   * The key for one stage of one logical intent. The same (group, content,
   * stage) always yields the same key until released; changed content under the
   * same group starts a new intent and retires the older keys.
   */
  keyFor(group: string, content: string, stage: string): string;
  /** Forgets one stage's key (the server said it was used with different input). */
  discard(group: string, content: string, stage: string): void;
  /** Forgets every key of a finished intent. */
  release(group: string, content: string): void;
}

/** 53-bit string hash: a short fingerprint so no request text is persisted. */
export function fingerprintOf(content: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${value.toString(36)}-${content.length.toString(36)}`;
}

function valid(entry: unknown): entry is Entry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.group === 'string' && FIELD_PATTERN.test(e.group) &&
    typeof e.fingerprint === 'string' && FIELD_PATTERN.test(e.fingerprint) &&
    typeof e.stage === 'string' && FIELD_PATTERN.test(e.stage) &&
    typeof e.key === 'string' && KEY_PATTERN.test(e.key) &&
    typeof e.at === 'number' && Number.isFinite(e.at)
  );
}

export function createOperationKeyStore(options: OperationKeyStoreOptions): OperationKeyStore {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const newKey = options.newKey ?? (() => `op-${globalThis.crypto.randomUUID()}`);
  const capacity = options.capacity ?? DEFAULT_OPERATION_KEY_CAPACITY;

  function load(): Entry[] {
    let raw: string | null;
    try {
      raw = storage.getItem(OPERATION_KEYS_STORAGE_KEY);
    } catch {
      throw new OperationKeyStoreError('Operation protection storage is unavailable.');
    }
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OperationKeyStoreError('Retry protection is damaged. Check earlier operations before retrying; no new create was sent.');
    }
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(entries) || entries.some((entry) => !valid(entry))) {
      throw new OperationKeyStoreError('Retry protection is damaged. Check earlier operations before retrying; no new create was sent.');
    }
    return entries;
  }

  function save(entries: Entry[]): void {
    try {
      storage.setItem(OPERATION_KEYS_STORAGE_KEY, JSON.stringify({ entries }));
    } catch {
      throw new OperationKeyStoreError('Could not save operation protection; nothing was created.');
    }
  }

  const same = (e: Entry, group: string, fingerprint: string): boolean =>
    e.group === group && e.fingerprint === fingerprint;

  return {
    keyFor(rawGroup, content, stage) {
      const group = fingerprintOf(rawGroup);
      const fingerprint = fingerprintOf(content);
      const entries = load();
      const existing = entries.find((e) => same(e, group, fingerprint) && e.stage === stage);
      if (existing) return existing.key;
      // Edited content is a new intent: retire the group's older intents.
      const kept = entries.filter((e) => e.group !== group || e.fingerprint === fingerprint);
      if (kept.length >= capacity) {
        throw new OperationKeyStoreError(
          'Too many earlier operations are unconfirmed. Check the workspace for them, then reload.',
        );
      }
      const key = newKey();
      save([...kept, { group, fingerprint, stage, key, at: now() }]);
      return key;
    },
    discard(rawGroup, content, stage) {
      const group = fingerprintOf(rawGroup);
      const fingerprint = fingerprintOf(content);
      save(load().filter((e) => !(same(e, group, fingerprint) && e.stage === stage)));
    },
    release(rawGroup, content) {
      const group = fingerprintOf(rawGroup);
      const fingerprint = fingerprintOf(content);
      save(load().filter((e) => !same(e, group, fingerprint)));
    },
  };
}

let shared: OperationKeyStore | undefined;

/** The browser-backed store shared by the app; survives full page reloads. */
export function browserOperationKeyStore(): OperationKeyStore {
  shared ??= createOperationKeyStore({
    storage: {
      getItem: (key) => globalThis.localStorage.getItem(key),
      setItem: (key, value) => globalThis.localStorage.setItem(key, value),
    },
  });
  return shared;
}

/** True when the backend provably rejected the request, so no create happened. */
export function isDefiniteRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429 &&
    error.code !== 'operation_pending'
  );
}

export const KEY_CLEANUP_WARNING =
  'It was created, but its retry protection could not be cleaned up, so repeating the identical request may reopen the same item.';

export const KEY_RESET_WARNING =
  'Retry protection for a failed request could not be reset, so repeating the identical request may be refused until it is cleared.';

/**
 * Releases keys after a confirmed outcome. A storage failure never fails the
 * create: it becomes a persistent app-level notice (visible after the dialog
 * closes or the view changes) and is returned for callers that want it too.
 */
export function releaseAfterOutcome(release: () => void, warning = KEY_CLEANUP_WARNING): string | null {
  try {
    release();
    return null;
  } catch (error) {
    console.warn('Operation key cleanup failed', error);
    pushOperationNotice(warning);
    return warning;
  }
}

/**
 * Runs one create under a durable key for its logical intent. The same
 * (group, content, stage) retries with the same key after an unknown outcome or
 * reload; success or a definite rejection retires it, so a later genuine create
 * gets a fresh key. A storage failure before sending throws and nothing is sent.
 * A cleanup failure after a committed result never hides that result: it is
 * reported as a persistent app notice.
 */
export async function withOperationKey<T>(
  group: string,
  content: unknown,
  stage: string,
  request: (operation: { operationKey: string }) => Promise<T>,
  store: OperationKeyStore = browserOperationKeyStore(),
): Promise<T> {
  const text = JSON.stringify(content);
  const operationKey = store.keyFor(group, text, stage);
  let result: T;
  try {
    result = await request({ operationKey });
  } catch (error) {
    if (isDefiniteRejection(error)) releaseAfterOutcome(() => store.release(group, text), KEY_RESET_WARNING);
    throw error;
  }
  releaseAfterOutcome(() => store.release(group, text));
  return result;
}