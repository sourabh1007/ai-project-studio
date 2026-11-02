import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { dismissOperationNotices, getOperationNotices } from './operation-notices';
import {
  KEY_CLEANUP_WARNING,
  KEY_RESET_WARNING,
  OPERATION_KEYS_STORAGE_KEY,
  OperationKeyStoreError,
  browserOperationKeyStore,
  createOperationKeyStore,
  fingerprintOf,
  isDefiniteRejection,
  releaseAfterOutcome,
  withOperationKey,
} from './operation-keys';

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(OPERATION_KEYS_STORAGE_KEY, initial);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function counterKeys() {
  let n = 0;
  return () => `op-key-${++n}0000`;
}

describe('fingerprintOf', () => {
  it('is stable, content sensitive and never contains the content', () => {
    expect(fingerprintOf('secret prompt')).toBe(fingerprintOf('secret prompt'));
    expect(fingerprintOf('a')).not.toBe(fingerprintOf('b'));
    expect(fingerprintOf('secret prompt')).not.toContain('secret');
  });
});

describe('createOperationKeyStore', () => {
  it('returns the same key per stage across store instances (page reload)', () => {
    const storage = memoryStorage();
    const first = createOperationKeyStore({ storage, newKey: counterKeys() });
    const key = first.keyFor('task-1', 'intent', 'feature');
    const reloaded = createOperationKeyStore({ storage, newKey: () => 'op-other-0000' });
    expect(reloaded.keyFor('task-1', 'intent', 'feature')).toBe(key);
    expect(reloaded.keyFor('task-1', 'intent', 'session')).not.toBe(key);
    expect(storage.data.get(OPERATION_KEYS_STORAGE_KEY)).not.toContain('intent');
  });

  it('does not merge different tasks with identical content', () => {
    const store = createOperationKeyStore({ storage: memoryStorage(), newKey: counterKeys() });
    expect(store.keyFor('task-1', 'same', 'feature')).not.toBe(store.keyFor('task-2', 'same', 'feature'));
  });

  it('retires a group’s older intents when its content is edited', () => {
    const store = createOperationKeyStore({ storage: memoryStorage(), newKey: counterKeys() });
    const old = store.keyFor('task-1', 'v1', 'feature');
    const edited = store.keyFor('task-1', 'v2', 'feature');
    expect(edited).not.toBe(old);
    expect(store.keyFor('task-1', 'v1', 'feature')).not.toBe(old);
  });

  it('discard drops one stage and release drops the whole intent', () => {
    const store = createOperationKeyStore({ storage: memoryStorage(), newKey: counterKeys() });
    const feature = store.keyFor('t', 'c', 'feature');
    const session = store.keyFor('t', 'c', 'session');
    store.discard('t', 'c', 'session');
    expect(store.keyFor('t', 'c', 'feature')).toBe(feature);
    expect(store.keyFor('t', 'c', 'session')).not.toBe(session);
    store.release('t', 'c');
    expect(store.keyFor('t', 'c', 'feature')).not.toBe(feature);
  });

  it('never expires or evicts an unresolved key, however old', () => {
    let now = 1_000;
    const storage = memoryStorage();
    const store = createOperationKeyStore({ storage, newKey: counterKeys(), now: () => now, capacity: 1 });
    const key = store.keyFor('t', 'c', 'feature');
    now += 400 * 24 * 60 * 60 * 1000;
    expect(store.keyFor('t', 'c', 'feature')).toBe(key);
    expect(() => store.keyFor('other', 'c', 'feature')).toThrow(OperationKeyStoreError);
    expect(store.keyFor('t', 'c', 'feature')).toBe(key);
  });
  it('rejects new intents at capacity instead of evicting unresolved keys', () => {
    const store = createOperationKeyStore({
      storage: memoryStorage(), newKey: counterKeys(), capacity: 2,
    });
    const a = store.keyFor('a', 'c', 'feature');
    store.keyFor('b', 'c', 'feature');
    expect(() => store.keyFor('c', 'c', 'feature')).toThrow(OperationKeyStoreError);
    expect(store.keyFor('a', 'c', 'feature')).toBe(a);
  });

  it('refuses malformed protection data instead of silently replacing unresolved keys', () => {
    const bad = JSON.stringify({
      entries: [null, 'x', { group: 'g' }, { group: 'g', fingerprint: 'f', stage: 's', key: 'short', at: 1 }],
    });
    for (const raw of [bad, 'not json', JSON.stringify({ entries: 'nope' }), 'null']) {
      const storage = memoryStorage(raw);
      const store = createOperationKeyStore({ storage, newKey: counterKeys(), now: () => 1 });
      expect(() => store.keyFor('t', 'c', 'feature')).toThrow(OperationKeyStoreError);
      expect(storage.data.get(OPERATION_KEYS_STORAGE_KEY)).toBe(raw);
    }
  });

  it('surfaces storage read and write failures', () => {
    const unreadable = createOperationKeyStore({
      storage: { getItem: () => { throw new Error('denied'); }, setItem: () => undefined },
    });
    expect(() => unreadable.keyFor('t', 'c', 'feature')).toThrow(/unavailable/);
    const unwritable = createOperationKeyStore({
      storage: { getItem: () => null, setItem: () => { throw new Error('full'); } },
    });
    expect(() => unwritable.keyFor('t', 'c', 'feature')).toThrow(/nothing was created/);
  });

  it('mints uuid based keys by default', () => {
    const store = createOperationKeyStore({ storage: memoryStorage() });
    expect(store.keyFor('t', 'c', 'feature')).toMatch(/^op-[0-9a-f-]{36}$/);
  });
});

describe('browserOperationKeyStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is shared and backed by localStorage', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const store = browserOperationKeyStore();
    const key = store.keyFor('t', 'c', 'feature');
    expect(browserOperationKeyStore()).toBe(store);
    expect(storage.data.get(OPERATION_KEYS_STORAGE_KEY)).toContain(key);
  });
});

describe('withOperationKey', () => {
  const lost = new TypeError('Failed to fetch');
  const fresh = () => createOperationKeyStore({ storage: memoryStorage(), newKey: counterKeys() });

  it('retries an unknown outcome with the same key and a later genuine create with a new one', async () => {
    const store = fresh();
    const sent: string[] = [];
    const request = vi.fn(async (op: { operationKey: string }) => {
      sent.push(op.operationKey);
      if (sent.length === 1) throw lost;
      return 'ok';
    });
    await expect(withOperationKey('g', { a: 1 }, 's', request, store)).rejects.toBe(lost);
    await expect(withOperationKey('g', { a: 1 }, 's', request, store)).resolves.toBe('ok');
    await withOperationKey('g', { a: 1 }, 's', request, store);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[2]).not.toBe(sent[0]);
  });

  it('keeps the key on pending and unavailable, retires it on a definite rejection', async () => {
    const store = fresh();
    const sent: string[] = [];
    const failures = [
      new ApiError(409, 'pending', 'operation_pending'),
      new ApiError(503, 'busy', 'operation_capacity'),
      new ApiError(429, 'slow'),
      new ApiError(400, 'bad'),
    ];
    for (const failure of failures) {
      await expect(
        withOperationKey('g', 1, 's', async (op) => { sent.push(op.operationKey); throw failure; }, store),
      ).rejects.toBe(failure);
    }
    await withOperationKey('g', 1, 's', async (op) => { sent.push(op.operationKey); }, store);
    expect(new Set(sent.slice(0, 4)).size).toBe(1);
    expect(sent[4]).not.toBe(sent[0]);
    expect(isDefiniteRejection(new ApiError(408, 't'))).toBe(false);
    expect(isDefiniteRejection(lost)).toBe(false);
  });

  it('does not send when protection cannot be stored', async () => {
    const broken = createOperationKeyStore({
      storage: { getItem: () => null, setItem: () => { throw new Error('full'); } },
    });
    const request = vi.fn();
    await expect(withOperationKey('g', 1, 's', request, broken)).rejects.toThrow(OperationKeyStoreError);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not repeat a possibly committed create after retry protection is corrupted during a reload', async () => {
    const storage = memoryStorage();
    const store = createOperationKeyStore({ storage, newKey: counterKeys() });
    const request = vi.fn().mockRejectedValueOnce(lost).mockResolvedValueOnce({ id: 'duplicate' });
    await expect(withOperationKey('g', 1, 's', request, store)).rejects.toBe(lost);
    const saved = storage.data.get(OPERATION_KEYS_STORAGE_KEY)!;
    storage.data.set(OPERATION_KEYS_STORAGE_KEY, saved.slice(0, -1));
    const reloaded = createOperationKeyStore({ storage, newKey: () => 'op-replacement-0000' });
    await expect(withOperationKey('g', 1, 's', request, reloaded)).rejects.toThrow(OperationKeyStoreError);
    expect(request).toHaveBeenCalledTimes(1);
    expect(storage.data.get(OPERATION_KEYS_STORAGE_KEY)).toBe(saved.slice(0, -1));
  });

  it('defaults to the browser store', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    try {
      await expect(withOperationKey('g2', 1, 's', async (op) => op.operationKey)).resolves.toMatch(/^op-/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('cleanup failure after a committed result', () => {
  afterEach(() => dismissOperationNotices());
  const quotaOnRemove = () => {
    const inner = memoryStorage();
    let writes = 0;
    const storage = {
      getItem: inner.getItem,
      setItem: (k: string, v: string) => {
        if (++writes > 1) throw new Error('QuotaExceededError');
        inner.setItem(k, v);
      },
    };
    return createOperationKeyStore({ storage, newKey: counterKeys() });
  };

  it('delivers the created result with a warning and keeps the key for the retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = quotaOnRemove();
    const request = vi.fn(async (op: { operationKey: string }) => ({ id: 'created', key: op.operationKey }));
    const result = await withOperationKey('g', 1, 's', request, store);
    expect(result).toEqual({ id: 'created', key: 'op-key-10000' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(getOperationNotices().message).toBe(KEY_CLEANUP_WARNING);
    expect(warn).toHaveBeenCalled();
    expect(store.keyFor('g', '1', 's')).toBe('op-key-10000');
    warn.mockRestore();
  });

  it('succeeds and still publishes the notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(withOperationKey('g', 1, 's', async () => 'ok', quotaOnRemove())).resolves.toBe('ok');
    warn.mockRestore();
  });

  it('keeps the original rejection when cleanup after a definite rejection fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejection = new ApiError(400, 'bad');
    await expect(withOperationKey('g', 1, 's', async () => { throw rejection; }, quotaOnRemove())).rejects.toBe(rejection);
    expect(getOperationNotices()?.message).toBe(KEY_RESET_WARNING);
    expect(getOperationNotices()?.message).not.toMatch(/was created/);
    warn.mockRestore();
  });

  it('releaseAfterOutcome reports null on success', () => {
    expect(releaseAfterOutcome(() => {})).toBeNull();
  });
});