import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../persistence/db/connection.js';
import { createSessionRepo } from '../persistence/session-repo.js';
import { createUsageCaptureRepo } from '../persistence/usage-capture-repo.js';
import { createUsageRepo } from '../persistence/usage-repo.js';
import { createCliUsageStore } from '../provider/cli-store/cli-usage-store.js';
import { createCreditCalculator } from '../credit/credit-calculator.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createUsageRecorder, type UsageRecordedMap } from '../usage/usage-recorder.js';
import { createCliUsageTailer } from '../usage/cli-usage-tailer.js';
import { createStoppedCaptureRecovery } from './stopped-capture-recovery.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(pageSize = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'cw-recovery-'));
  const db = createDatabase({ databasePath: ':memory:' });
  const sessions = createSessionRepo(db);
  const captures = createUsageCaptureRepo(db);
  const usage = createUsageRepo(db);
  const bus = createEventBus<UsageRecordedMap>();
  const calculator = createCreditCalculator([
    { id: 'provider', compute: (event) => event.cost },
  ], { activeStrategy: 'provider', unit: 'AIC' });
  const recorder = createUsageRecorder({ repo: usage, calculator, bus });
  const stores = new Map<string, ReturnType<typeof createCliUsageStore>>();
  const sources = new Map<string, DatabaseSync>();
  const callbacks: (() => void)[] = [];
  const live = new Set<string>();
  const error = vi.fn();
  const clearInterval = vi.fn();
  const historicalTimer = vi.fn(() => { throw new Error('Historical tailers must not start timers'); });
  const page = vi.spyOn(captures, 'listUnfinishedPage');
  let closed = false;
  const close = () => {
    if (!closed) { db.close(); closed = true; }
  };
  const recovery = createStoppedCaptureRecovery({
    captures, sessions, pageSize, intervalMs: 100,
    logger: { error },
    hasLiveTailer: (id) => live.has(id),
    scheduler: {
      setInterval: (callback) => { callbacks.push(callback); return callbacks.length; },
      clearInterval,
    },
    makeTailer: (session) => {
      const store = stores.get(session.id)!;
      return createCliUsageTailer({
        sessionId: session.id, sourceId: store.sourceId, captures, recorder,
        read: (cursor, limit) => store.readUsagePage(session.id, {
          featureId: session.featureId, provider: session.provider, requestedModel: session.requestedModel,
        }, cursor, limit),
        kind: session.kind, intervalMs: 100, pageSize: 2, finalDrainPages: 2,
        scheduler: { setInterval: historicalTimer, clearInterval: vi.fn() },
      });
    },
  });
  cleanups.push(() => {
    recovery.stop();
    for (const source of sources.values()) source.close();
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec("INSERT INTO features (id,name,description,created_at) VALUES ('f1','feature','','t')");
  const path = (id: string) => join(directory, `${id}.db`);
  const seed = (id: string) => {
    db.prepare(`INSERT INTO sessions
      (id,feature_id,provider,requested_model,status,kind,prompt,usage_file_path,created_at,ended_at)
      VALUES (?,'f1','agency','auto','completed','dev','','','t','t')`).run(id);
    const store = createCliUsageStore({ databasePath: path(id) });
    stores.set(id, store);
    captures.save({
      sessionId: id, sourceId: store.sourceId, cursor: null, status: 'pending', reason: 'source-finality-unknown',
    });
  };
  const createSource = (id: string) => {
    const source = new DatabaseSync(path(id));
    sources.set(id, source);
    source.exec(`CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT)`);
    return source;
  };
  const insert = (sessionId: string, id: number, credits: number) => {
    sources.get(sessionId)!.prepare('INSERT INTO assistant_usage_events VALUES (?,?,0,?,10,20,0,?,NULL,?)')
      .run(id, sessionId, 'model', credits * 1e9, `2026-01-01T00:00:${id.toString().padStart(2, '0')}.000Z`);
  };
  const liveTailer = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Missing session ${sessionId}`);
    live.add(sessionId);
    const tailer = createCliUsageTailer({
      sessionId,
      sourceId: stores.get(sessionId)!.sourceId,
      captures,
      recorder,
      read: (cursor, limit) => stores.get(sessionId)!.readUsagePage(sessionId, {
        featureId: session.featureId,
        provider: session.provider,
        requestedModel: session.requestedModel,
      }, cursor, limit),
      kind: session.kind,
      intervalMs: 100,
      pageSize: 2,
      finalDrainPages: 2,
      scheduler: { setInterval: historicalTimer, clearInterval: vi.fn() },
    });
    return {
      tailer,
      release() {
        tailer.stop();
        live.delete(sessionId);
      },
    };
  };
  return {
    db, sessions, captures, usage, bus, recovery, error, callbacks, historicalTimer,
    page, clearInterval, live, seed, createSource, insert, path, close, liveTailer,
    tick: () => callbacks[callbacks.length - 1](),
    removeSource: (id: string) => {
      sources.get(id)!.close();
      sources.delete(id);
      rmSync(path(id));
    },
  };
}

describe('ongoing stopped capture recovery with production SQLite and real source stores', () => {
  it('recovers late rows for an ended session in the same process after live finalization stops at a missing source', () => {
    const f = fixture();
    f.seed('a');
    const live = f.liveTailer('a');

    live.tailer.drain();
    expect(f.captures.get('a')).toMatchObject({ status: 'retrying', reason: 'source-missing' });

    const current = f.sessions.get('a');
    if (!current) {
      throw new Error('missing session a');
    }
    f.sessions.save({ ...current, status: 'completed', endedAt: '2026-01-01T00:02:00.000Z' });
    live.tailer.finalize();
    live.release();

    f.recovery.start();
    expect(f.usage.listBySession('a')).toEqual([]);

    f.createSource('a');
    f.insert('a', 1, 6);
    f.tick();

    expect(f.usage.listBySession('a').map((event) => event.credits)).toEqual([6]);
    expect(f.captures.get('a')).toMatchObject({ status: 'pending' });
    expect(f.sessions.get('a')?.status).toBe('completed');
    expect(f.historicalTimer).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
  });

  it('captures late publication and corrections without app restart or per-session timers', () => {
    const f = fixture();
    f.seed('a');
    f.recovery.start();
    expect(f.captures.get('a')).toMatchObject({ status: 'retrying', reason: 'source-missing' });
    expect(f.usage.listBySession('a')).toEqual([]);
    const source = f.createSource('a');
    f.insert('a', 1, 3);
    f.tick();
    expect(f.usage.listBySession('a').map((event) => event.credits)).toEqual([3]);
    source.exec('UPDATE assistant_usage_events SET total_nano_aiu=9000000000 WHERE id=1');
    for (let count = 0; count < 3; count++) f.tick();
    expect(f.usage.listBySession('a').map((event) => event.credits)).toEqual([9]);
    expect(f.captures.get('a')?.status).not.toBe('complete');
    expect(f.sessions.get('a')?.status).toBe('completed');
    expect(f.callbacks).toHaveLength(1);
    expect(f.historicalTimer).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
  });

  it('advances past missing sources and live sessions and fairly wraps the keyset cursor', () => {
    const f = fixture(1);
    for (const id of ['a', 'b', 'c']) f.seed(id);
    f.live.add('b');
    f.createSource('c'); f.insert('c', 1, 7);
    f.recovery.start();
    f.tick(); f.tick();
    expect(f.usage.listBySession('c').map((event) => event.credits)).toEqual([7]);
    expect(f.page.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'a', 'b']);
    f.live.delete('b');
    f.createSource('b'); f.insert('b', 1, 4);
    f.tick(); f.tick();
    expect(f.usage.listBySession('b').map((event) => event.credits)).toEqual([4]);
    expect(f.page.mock.calls.every(([, limit]) => limit === 1)).toBe(true);
  });

  it('recovers from a real source lock on a later cycle without starving another capture', () => {
    const f = fixture(1);
    f.seed('a'); f.seed('b');
    f.createSource('a'); f.insert('a', 1, 3);
    f.createSource('b'); f.insert('b', 1, 4);
    const lock = new DatabaseSync(f.path('a'));
    try {
      lock.exec('BEGIN EXCLUSIVE');
      f.recovery.start();
      expect(f.captures.get('a')?.status).toBe('retrying');
      f.tick();
      expect(f.usage.listBySession('b').map((event) => event.credits)).toEqual([4]);
      lock.exec('ROLLBACK');
      f.tick();
      expect(f.usage.listBySession('a').map((event) => event.credits)).toEqual([3]);
    } finally {
      lock.close();
    }
  });

  it('continues bounded ledger repair after the source has been pruned', () => {
    const f = fixture(1);
    f.seed('a'); f.createSource('a');
    for (let id = 1; id <= 7; id++) f.insert('a', id, id);
    f.recovery.start();
    for (let count = 0; count < 4; count++) f.tick();
    expect(f.usage.listBySession('a')).toHaveLength(7);
    f.db.exec('DELETE FROM usage_events');
    f.removeSource('a');
    let previous = 0;
    for (let count = 0; count < 8; count++) {
      f.tick();
      const current = f.usage.listBySession('a').length;
      expect(current - previous).toBeLessThanOrEqual(4);
      previous = current;
    }
    expect(f.usage.listBySession('a').map((event) => event.credits)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(f.captures.get('a')).toMatchObject({ status: 'retrying', reason: 'source-missing' });
  });

  it('does not resurrect a session deleted after its page snapshot was read', () => {
    const f = fixture(2);
    for (const id of ['a', 'b']) {
      f.seed(id); f.createSource(id); f.insert(id, 1, 2);
    }
    f.bus.on('usage.recorded', (event) => {
      if (event.sessionId === 'a') {
        f.db.prepare('DELETE FROM sessions WHERE id=?').run('b');
        f.captures.deleteBySession('b');
      }
    });
    f.recovery.start();
    f.tick();
    expect(f.sessions.get('b')).toBeNull();
    expect(f.captures.get('b')).toBeNull();
    expect(f.usage.listBySession('b')).toEqual([]);
    expect(f.error).not.toHaveBeenCalled();
  });

  it('permits a bounded shutdown drain before closing the DB but rejects stale timer callbacks afterward', () => {
    const f = fixture();
    f.seed('a');
    f.recovery.start();
    f.createSource('a'); f.insert('a', 1, 5);
    f.recovery.stop();
    f.recovery.finalize();
    expect(f.usage.listBySession('a').map((event) => event.credits)).toEqual([5]);
    const reads = f.page.mock.calls.length;
    f.close();
    expect(() => f.tick()).not.toThrow();
    expect(f.page).toHaveBeenCalledTimes(reads);
    expect(f.error).not.toHaveBeenCalled();
    expect(f.clearInterval).toHaveBeenCalledOnce();
  });
});
