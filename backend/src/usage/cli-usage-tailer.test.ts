import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createDatabase } from '../persistence/db/connection.js';
import { createUsageCaptureRepo } from '../persistence/usage-capture-repo.js';
import { createUsageRepo } from '../persistence/usage-repo.js';
import { createCliUsageStore } from '../provider/cli-store/cli-usage-store.js';
import { createCreditCalculator } from '../credit/credit-calculator.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createUsageRecorder, type UsageRecordedMap } from './usage-recorder.js';
import { createCliUsageTailer, type CliUsageTailerDeps, type TailScheduler } from './cli-usage-tailer.js';
import type { UsageCaptureRead } from './usage-capture-contract.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); });

function fixture() {
  const dir = join(process.cwd(), `.usage-fixture-${randomUUID()}`);
  mkdirSync(dir);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'source.db');
  let source = new DatabaseSync(sourcePath);
  cleanups.push(() => source.close());
  const sourceSchema = `CREATE TABLE assistant_usage_events (
    id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, model TEXT,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT)`;
  source.exec(sourceSchema);
  const targetPath = join(dir, 'target.db');
  let db = createDatabase({ databasePath: targetPath });
  cleanups.push(() => db.close());
  db.exec(`INSERT INTO features (id, name, description, created_at) VALUES ('f1','f','','t');
    INSERT INTO sessions (id,feature_id,provider,requested_model,status,kind,prompt,usage_file_path,created_at)
      VALUES ('s1','f1','agency','auto','running','dev','','','t')`);
  const store = createCliUsageStore({ databasePath: sourcePath });
  const bus = createEventBus<UsageRecordedMap>();
  const emitted = vi.fn();
  bus.on('usage.recorded', emitted);
  const calculator = createCreditCalculator([{ id: 'provider', compute: (event) => event.cost }], { activeStrategy: 'provider', unit: 'AIC' });
  let tick: () => void = () => {};
  const scheduler: TailScheduler = { setInterval: (cb) => { tick = cb; return 'timer'; }, clearInterval: vi.fn() };
  const deps = (): CliUsageTailerDeps => ({
    sessionId: 's1', sourceId: store.sourceId,
    read: (cursor, limit) => store.readUsagePage('s1', { featureId: 'f1', provider: 'agency', requestedModel: 'auto' }, cursor, limit),
    captures: createUsageCaptureRepo(db),
    recorder: createUsageRecorder({ repo: createUsageRepo(db), calculator, bus }),
    kind: 'dev', intervalMs: 10, pageSize: 2, finalDrainPages: 2, scheduler,
  });
  const insert = (id: number, credits = 1, createdAt = `t${id}`) => source.prepare(
    "INSERT INTO assistant_usage_events VALUES (?,'s1',0,'model',10,20,0,?,1,?)",
  ).run(id, credits * 1e9, createdAt);
  return {
    get source() { return source; }, store, insert, deps, emitted, scheduler, fire: () => tick(),
    usage: () => createUsageRepo(db).listBySession('s1'),
    captures: () => createUsageCaptureRepo(db),
    db: () => db,
    restart: () => { db.close(); db = createDatabase({ databasePath: targetPath }); },
    replaceSource: () => {
      source.close(); rmSync(sourcePath); source = new DatabaseSync(sourcePath); source.exec(sourceSchema);
    },
    removeSource: () => {
      source.close(); rmSync(sourcePath); source = new DatabaseSync(':memory:');
    },
  };
}

describe('durable CLI usage capture with real source and recorder databases', () => {
  it('persists stable identities, catches same-count corrections, out-of-order insertions and pruning without double-counting', () => {
    const f = fixture();
    f.insert(10, 3); f.insert(20, 5);
    const tailer = createCliUsageTailer(f.deps());
    tailer.start(); tailer.start();
    expect(f.usage().map((e) => [e.turnIndex, e.credits])).toEqual([[0, 3], [1, 5]]);
    f.fire();
    expect(f.emitted).toHaveBeenCalledTimes(2);
    f.source.exec('UPDATE assistant_usage_events SET total_nano_aiu=7000000000 WHERE id=20');
    f.fire();
    expect(f.usage().map((e) => e.credits)).toEqual([3, 7]);
    f.source.exec('DELETE FROM assistant_usage_events WHERE id=10');
    f.insert(5, 2);
    f.fire();
    expect(f.usage().map((e) => [e.turnIndex, e.credits])).toEqual([[0, 3], [1, 7], [2, 2]]);
    tailer.stop(); tailer.stop();
    expect(f.scheduler.clearInterval).toHaveBeenCalledTimes(1);
    f.restart();
    const resumed = createCliUsageTailer(f.deps());
    expect(resumed.status().reason).toBe('source-finality-unknown');
    resumed.drain();
    expect(f.usage()).toHaveLength(3);
    expect(f.emitted).toHaveBeenCalledTimes(4);
  });

  it('bounds each poll/final backfill and resumes a partial reconciliation after reopening the app database', () => {
    const f = fixture();
    for (let id = 1; id <= 7; id++) f.insert(id);
    const tailer = createCliUsageTailer(f.deps());
    expect(tailer.drain()).toMatchObject({ cursor: '2', reason: 'backfill-in-progress' });
    expect(f.usage()).toHaveLength(2);
    expect(tailer.finalize()).toMatchObject({ cursor: '6', status: 'pending' });
    expect(f.usage()).toHaveLength(6);
    f.restart();
    const resumed = createCliUsageTailer(f.deps());
    resumed.drain();
    expect(f.usage()).toHaveLength(7);
    expect(resumed.status()).toMatchObject({ cursor: null, reason: 'source-finality-unknown' });
    f.source.exec('UPDATE assistant_usage_events SET total_nano_aiu=9000000000 WHERE id=1');
    resumed.drain();
    expect(f.usage()[0].credits).toBe(9);
  });

  it('converges across repeated bounded finalization and real database reopening instead of restarting its prefix', () => {
    const f = fixture();
    for (let id = 1; id <= 7; id++) f.insert(id, id);
    expect(createCliUsageTailer(f.deps()).finalize()).toMatchObject({ cursor: '4', status: 'pending' });
    expect(f.usage()).toHaveLength(4);
    f.restart();
    expect(createCliUsageTailer(f.deps()).finalize()).toMatchObject({
      cursor: null, replayCursor: null, sourceDone: true, replayDone: true,
      status: 'pending', reason: 'source-finality-unknown',
    });
    expect(f.usage().map((event) => event.credits)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    f.restart();
    createCliUsageTailer(f.deps()).finalize();
    expect(f.usage()).toHaveLength(7);
    expect(f.emitted).toHaveBeenCalledTimes(7);
  });

  it('uses the full bounded ledger budget while the real source is missing and resumes all seven retained payloads', () => {
    const f = fixture();
    for (let id = 1; id <= 7; id++) f.insert(id, id);
    const initial = createCliUsageTailer(f.deps());
    initial.finalize(); initial.finalize();
    f.db().exec('DELETE FROM usage_events');
    f.removeSource();
    f.restart();
    expect(createCliUsageTailer(f.deps()).finalize()).toMatchObject({
      status: 'retrying', reason: 'source-missing', replayCursor: 3,
    });
    expect(f.usage()).toHaveLength(4);
    f.restart();
    expect(createCliUsageTailer(f.deps()).finalize()).toMatchObject({
      status: 'retrying', reason: 'source-missing', replayCursor: null, replayDone: true,
    });
    expect(f.usage().map((event) => event.credits)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    f.db().exec('DELETE FROM usage_events WHERE turn_index=0');
    createCliUsageTailer(f.deps()).finalize();
    expect(f.usage()).toHaveLength(7);
  });

  it('stops a no-progress missing-source attempt without spending the remaining finalization budget', () => {
    const f = fixture(); f.removeSource();
    const deps = f.deps();
    deps.finalDrainPages = 50;
    deps.read = vi.fn(deps.read);
    deps.captures.listReplay = vi.fn(deps.captures.listReplay);
    expect(createCliUsageTailer(deps).finalize()).toMatchObject({ status: 'retrying', reason: 'source-missing' });
    expect(deps.read).toHaveBeenCalledTimes(1);
    expect(deps.captures.listReplay).toHaveBeenCalledTimes(1);
  });

  it('completes a persisted source-final replay proof without rereading the source', () => {
    const f = fixture();
    f.captures().save({
      sessionId: 's1',
      sourceId: f.store.sourceId,
      cursor: null,
      replayCursor: null,
      finalScan: true,
      replayClean: true,
      sourceDone: true,
      replayDone: false,
      status: 'pending',
      reason: 'source-finality-unknown',
    });
    const deps = f.deps();
    const read = vi.fn(deps.read);
    deps.read = read;

    expect(createCliUsageTailer(deps).drain()).toMatchObject({
      status: 'complete',
      reason: null,
      sourceDone: true,
      replayDone: true,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('persists full post-finality scan proof across bounded calls and restart, without crediting an earlier nonfinal prefix as final', () => {
    const f = fixture();
    for (let id = 1; id <= 7; id++) f.insert(id);
    let authoritative = false;
    const make = () => {
      const deps = f.deps();
      const read = deps.read;
      deps.read = (cursor, limit) => {
        const result = read(cursor, limit);
        return result.status === 'ready' ? { ...result, final: authoritative } : result;
      };
      return createCliUsageTailer(deps);
    };
    expect(make().finalize().status).toBe('pending');
    authoritative = true;
    f.restart();
    expect(make().finalize().status).toBe('pending');
    f.restart();
    expect(make().finalize()).toMatchObject({ status: 'pending', finalScan: true, cursor: '4' });
    f.restart();
    expect(make().finalize()).toMatchObject({ status: 'complete', reason: null });
    expect(f.captures().listUnfinished()).toEqual([]);
  });

  it('does not turn EOF into completion; captures rows appearing after stop/finalize on restart', () => {
    const f = fixture();
    const tailer = createCliUsageTailer(f.deps());
    tailer.stop();
    expect(tailer.finalize()).toMatchObject({ status: 'pending', reason: 'source-finality-unknown' });
    expect(f.captures().listUnfinished()).toHaveLength(1);
    f.insert(1, 4);
    f.restart();
    expect(createCliUsageTailer(f.deps()).drain().status).toBe('pending');
    expect(f.usage()[0].credits).toBe(4);
  });

  it('persists missing-store recovery and captures a database published only after finalization', () => {
    const f = fixture(); f.insert(1, 6);
    const latePath = join(dirname(f.store.sourceId), 'published-later.db');
    const lateStore = createCliUsageStore({ databasePath: latePath });
    const deps = f.deps();
    deps.sourceId = lateStore.sourceId;
    deps.read = (cursor, limit) => lateStore.readUsagePage('s1', { featureId: 'f1', provider: 'agency', requestedModel: 'auto' }, cursor, limit);
    expect(createCliUsageTailer(deps).finalize()).toMatchObject({ status: 'retrying', reason: 'source-missing' });
    expect(f.captures().listUnfinished()[0].reason).toBe('source-missing');
    copyFileSync(f.store.sourceId, latePath);
    createCliUsageTailer(deps).finalize();
    expect(f.usage()[0].credits).toBe(6);
  });

  it('retries actual SQLite locks without checkpointing an empty success', () => {
    const f = fixture(); f.insert(1);
    f.source.exec('BEGIN EXCLUSIVE');
    const tailer = createCliUsageTailer(f.deps());
    expect(tailer.finalize()).toMatchObject({ status: 'retrying', reason: 'source-locked', cursor: null });
    expect(f.usage()).toHaveLength(0);
    f.source.exec('ROLLBACK');
    expect(tailer.finalize().status).toBe('pending');
    expect(f.usage()).toHaveLength(1);
  });

  it('retries a real final usage INSERT failure with its durable reserved ordinal intact', () => {
    const f = fixture(); f.insert(1);
    f.db().exec(`CREATE TRIGGER usage.reject_usage BEFORE INSERT ON usage_events
      BEGIN SELECT RAISE(FAIL, 'injected usage failure'); END`);
    const tailer = createCliUsageTailer(f.deps());
    expect(tailer.finalize()).toMatchObject({ status: 'retrying', reason: 'usage-recording-failed' });
    expect(f.usage()).toHaveLength(0);
    expect(f.db().prepare('SELECT fingerprint FROM usage_capture_rows').get()).toEqual({ fingerprint: null });
    f.db().exec('DROP TRIGGER usage.reject_usage');
    f.restart();
    createCliUsageTailer(f.deps()).finalize();
    expect(f.usage().map((e) => e.turnIndex)).toEqual([0]);
  });

  it('recovers every staged observation after a sink insert failure and provider pruning across restart', () => {
    const f = fixture(); f.insert(1, 4); f.insert(2, 2);
    f.db().exec(`CREATE TRIGGER usage.reject_usage BEFORE INSERT ON usage_events
      BEGIN SELECT RAISE(FAIL, 'sink unavailable'); END`);
    expect(createCliUsageTailer(f.deps()).finalize().reason).toBe('usage-recording-failed');
    expect(f.usage()).toHaveLength(0);
    expect(f.db().prepare('SELECT COUNT(*) AS n FROM usage_capture_rows WHERE event_payload != ?').get('')).toEqual({ n: 2 });
    f.source.exec('DELETE FROM assistant_usage_events');
    f.db().exec('DROP TRIGGER usage.reject_usage');
    f.restart();
    createCliUsageTailer(f.deps()).drain();
    expect(f.usage().map((event) => [event.turnIndex, event.credits])).toEqual([[0, 4], [1, 2]]);
  });

  it('retains a failed correction and restores it even after the source row disappears', () => {
    const f = fixture(); f.insert(1, 1);
    const tailer = createCliUsageTailer(f.deps());
    tailer.drain();
    f.source.exec('UPDATE assistant_usage_events SET total_nano_aiu=9000000000');
    f.db().exec(`CREATE TRIGGER usage.reject_usage BEFORE INSERT ON usage_events
      BEGIN SELECT RAISE(FAIL, 'sink unavailable'); END`);
    expect(tailer.drain().reason).toBe('usage-recording-failed');
    expect(f.usage()[0].credits).toBe(1);
    f.source.exec('DELETE FROM assistant_usage_events');
    f.db().exec('DROP TRIGGER usage.reject_usage');
    f.restart();
    createCliUsageTailer(f.deps()).finalize();
    expect(f.usage().map((event) => event.credits)).toEqual([9]);
  });

  it('repairs simulated acknowledged sink loss/divergence without depending on retained provider rows', () => {
    const f = fixture(); f.insert(1, 3); f.insert(2, 5);
    createCliUsageTailer(f.deps()).drain();
    f.source.exec('DELETE FROM assistant_usage_events');
    // Simulate independent sink loss; this is not a claim about a physical WAL crash.
    f.db().exec('DELETE FROM usage_events WHERE turn_index=0; UPDATE usage_events SET credits=999 WHERE turn_index=1');
    f.restart();
    const tailer = createCliUsageTailer(f.deps());
    tailer.drain();
    expect(f.usage().map((event) => event.credits)).toEqual([3, 5]);
    expect(f.emitted).toHaveBeenCalledTimes(4);
    tailer.drain();
    expect(f.emitted).toHaveBeenCalledTimes(4);
  });

  it('captures canonical credits when unused provider multiplier metadata is null', () => {
    const f = fixture(); f.insert(1, 4);
    f.source.exec('UPDATE assistant_usage_events SET request_multiplier=NULL');
    expect(createCliUsageTailer(f.deps()).drain()).toMatchObject({ status: 'pending', reason: 'source-finality-unknown' });
    expect(f.usage()[0].credits).toBe(4);
  });

  it('rejects rollbackable outer capture transactions instead of acknowledging speculative commits', () => {
    const f = fixture(); f.insert(1);
    const tailer = createCliUsageTailer(f.deps());
    f.db().exec('BEGIN');
    expect(tailer.drain()).toMatchObject({ reason: 'checkpoint-unavailable' });
    f.db().exec('ROLLBACK');
    expect(f.usage()).toHaveLength(0);
    expect(f.captures().get('s1')).toBeNull();
    tailer.drain();
    expect(f.usage()).toHaveLength(1);
  });

  it('never acknowledges a sink wrapper returning an uncommitted write; retained payload survives rollback and pruning', () => {
    const f = fixture(); f.insert(1, 4);
    const deps = f.deps();
    const reconcile = deps.recorder.reconcile;
    deps.recorder.reconcile = (event, kind) => {
      f.db().exec('BEGIN');
      return reconcile(event, kind);
    };
    expect(createCliUsageTailer(deps).drain().reason).toBe('checkpoint-unavailable');
    f.db().exec('ROLLBACK');
    expect(f.usage()).toHaveLength(0);
    expect(f.db().prepare('SELECT fingerprint FROM usage_capture_rows').get()).toEqual({ fingerprint: null });
    f.source.exec('DELETE FROM assistant_usage_events');
    f.restart();
    createCliUsageTailer(f.deps()).drain();
    expect(f.usage()[0].credits).toBe(4);
  });

  it('refuses corrupt payload attribution and bounds retained canonical metadata', () => {
    const f = fixture(); f.insert(1);
    const tailer = createCliUsageTailer(f.deps());
    tailer.drain();
    const row = f.db().prepare('SELECT event_payload FROM usage_capture_rows').get() as { event_payload: string };
    const event = JSON.parse(row.event_payload);
    f.db().prepare('UPDATE usage_capture_rows SET event_payload=?').run(JSON.stringify({ ...event, sessionId: 'other' }));
    expect(tailer.drain()).toMatchObject({ status: 'unsupported', reason: 'capture-payload-identity-mismatch' });
    f.db().prepare('UPDATE usage_capture_rows SET event_payload=?').run(JSON.stringify({ ...event, turnIndex: 99 }));
    expect(tailer.drain()).toMatchObject({ status: 'unsupported', reason: 'capture-payload-identity-mismatch' });
    f.db().prepare('UPDATE usage_capture_rows SET event_payload=?').run(row.event_payload);
    f.source.prepare('UPDATE assistant_usage_events SET model=?').run('x'.repeat(1025));
    expect(tailer.drain()).toMatchObject({ status: 'retrying', reason: 'identity-reservation-failed' });
    expect(f.usage()).toHaveLength(1);
    expect(f.usage()[0].resolvedModel).toBe('model');
  });

  it('exposes legacy missing payloads honestly and refreshes them when the provider still retains the row', () => {
    const f = fixture(); f.insert(1, 4);
    const tailer = createCliUsageTailer(f.deps());
    tailer.drain();
    f.db().exec("UPDATE usage_capture_rows SET event_payload=''; DELETE FROM usage_events");
    expect(tailer.drain()).toMatchObject({ status: 'retrying', reason: 'capture-payload-unavailable' });
    expect(f.usage()[0].credits).toBe(4);
    expect(tailer.drain().status).toBe('pending');
  });

  it('replays safely after usage commits but the identity checkpoint fails', () => {
    const f = fixture(); f.insert(1, 3);
    const deps = f.deps();
    const acknowledge = deps.captures.acknowledge;
    deps.captures.acknowledge = vi.fn(() => { throw new Error('disk failure'); });
    expect(createCliUsageTailer(deps).finalize().reason).toBe('identity-checkpoint-failed');
    expect(f.usage()).toHaveLength(1);
    expect(f.emitted).toHaveBeenCalledTimes(1);
    deps.captures.acknowledge = acknowledge;
    f.restart();
    createCliUsageTailer(f.deps()).finalize();
    expect(f.usage()).toHaveLength(1);
    expect(f.usage()[0].credits).toBe(3);
    expect(f.emitted).toHaveBeenCalledTimes(1);
  });

  it('recovers a committed identity reservation when interrupted before the usage write', () => {
    const f = fixture(); f.insert(1);
    const deps = f.deps();
    const reserve = deps.captures.reserve;
    deps.captures.reserve = (...args) => { reserve(...args); throw new Error('interrupted before record'); };
    expect(createCliUsageTailer(deps).drain()).toMatchObject({ status: 'retrying', reason: 'identity-reservation-failed', cursor: null });
    expect(f.usage()).toHaveLength(0);
    f.restart();
    createCliUsageTailer(f.deps()).drain();
    expect(f.usage().map((event) => event.turnIndex)).toEqual([0]);
  });

  it('replays without rewriting usage after acknowledgement succeeds but page checkpoint fails', () => {
    const f = fixture(); f.insert(1);
    const deps = f.deps();
    const save = deps.captures.save;
    deps.captures.save = (s) => { if (s.reason === 'source-finality-unknown') throw new Error('checkpoint'); save(s); };
    expect(createCliUsageTailer(deps).drain().reason).toBe('checkpoint-failed');
    f.restart();
    createCliUsageTailer(f.deps()).drain();
    expect(f.usage()).toHaveLength(1);
    expect(f.emitted).toHaveBeenCalledTimes(1);
  });

  it('stops finalize immediately when checkpoint persistence is unavailable', () => {
    const f = fixture();
    const deps = f.deps();
    const read = vi.fn(deps.read);
    deps.read = read;
    deps.captures.save = () => {
      throw new Error('disk');
    };

    expect(createCliUsageTailer(deps).finalize()).toMatchObject({
      status: 'retrying',
      reason: 'checkpoint-unavailable',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('adopts legacy ordinals but refuses ambiguous legacy matching rather than overwriting or duplicating', () => {
    const f = fixture(); f.insert(1);
    const deps = f.deps();
    const read = deps.read(null, 2);
    if (read.status !== 'ready') throw new Error('fixture');
    const event = read.rows[0].event;
    deps.recorder.reconcile({ ...event, turnIndex: 8, cost: 9 }, 'dev');
    createCliUsageTailer(deps).drain();
    expect(f.usage().map((e) => [e.turnIndex, e.credits])).toEqual([[8, 1]]);
    f.insert(2);
    const duplicate = { ...event, startedAt: 't2', endedAt: 't2' };
    deps.recorder.reconcile({ ...duplicate, turnIndex: 10 }, 'dev');
    deps.recorder.reconcile({ ...duplicate, turnIndex: 11 }, 'dev');
    expect(createCliUsageTailer(f.deps()).drain()).toMatchObject({ status: 'unsupported', reason: 'legacy-identity-ambiguous' });
    expect(f.usage()).toHaveLength(3);
  });

  it('preserves credited history when a truncated source reuses row IDs for new requests', () => {
    const f = fixture(); f.insert(1, 4);
    createCliUsageTailer(f.deps()).drain();
    f.source.exec('DELETE FROM assistant_usage_events');
    f.insert(1, 2, 'new-generation');
    f.restart();
    createCliUsageTailer(f.deps()).drain();
    expect(f.usage().map((e) => e.credits)).toEqual([4, 2]);
    f.replaceSource();
    f.insert(1, 2, 'new-generation');
    f.insert(2, 5, 'replacement-row');
    createCliUsageTailer(f.deps()).drain();
    expect(f.usage().map((e) => e.credits)).toEqual([4, 2, 5]);
  });

  it('handles source/persistence exceptions explicitly and never reports checkpoint failures as complete', () => {
    const f = fixture();
    const deps = f.deps();
    deps.read = () => { throw new Error('source'); };
    expect(createCliUsageTailer(deps).drain().reason).toBe('source-read-failed');
    deps.captures.save = () => { throw new Error('disk'); };
    expect(createCliUsageTailer(deps).drain()).toMatchObject({ status: 'retrying', reason: 'checkpoint-unavailable' });
  });

  it('propagates unsupported sources, rejects changed source identity and respects authoritative finality only at EOF', () => {
    const f = fixture();
    const deps = f.deps();
    let result: UsageCaptureRead = { status: 'unsupported', sourceId: deps.sourceId, reason: 'unsupported' };
    deps.read = () => result;
    const tailer = createCliUsageTailer(deps);
    expect(tailer.finalize()).toMatchObject({ status: 'unsupported' });
    result = { status: 'ready', sourceId: 'different', rows: [], nextCursor: null, final: true };
    expect(tailer.drain().reason).toBe('source-identity-changed');
    result = { ...result, sourceId: deps.sourceId, nextCursor: '3' };
    expect(tailer.drain().status).toBe('pending');
    result = { ...result, nextCursor: null };
    expect(tailer.finalize()).toMatchObject({ status: 'complete', reason: null });
    expect(f.captures().listUnfinished()).toEqual([]);
  });

  it('requires an entire clean scan after authoritative finality, including after checkpoint recovery', () => {
    const f = fixture();
    const deps = f.deps();
    let result: UsageCaptureRead = { status: 'ready', sourceId: deps.sourceId, rows: [], nextCursor: '2', final: false };
    deps.read = () => result;
    let tailer = createCliUsageTailer(deps);
    tailer.drain();
    result = { ...result, final: true, nextCursor: null };
    expect(tailer.drain().status).toBe('pending');
    result = { ...result, nextCursor: '2', issue: { status: 'retrying', reason: 'incomplete-row' } };
    expect(tailer.drain().status).toBe('retrying');
    result = { status: 'ready', sourceId: deps.sourceId, rows: [], nextCursor: null, final: true };
    expect(tailer.drain().status).toBe('pending');
    result = { ...result, nextCursor: '2' };
    tailer.drain();
    tailer = createCliUsageTailer(deps);
    result = { ...result, nextCursor: null };
    expect(tailer.drain().status).toBe('complete');
    result = { ...result, nextCursor: '2' };
    tailer.drain();
    result = { ...result, nextCursor: null };
    expect(tailer.drain().status).toBe('complete');
  });

  it('prevents reentrant drains and returns status copies', () => {
    const f = fixture(); f.insert(1);
    const deps = f.deps();
    const record = deps.recorder.reconcile;
    const tailer = createCliUsageTailer(deps);
    deps.recorder.reconcile = (event, kind) => { expect(tailer.drain().reason).toBe('capture-in-progress'); return record(event, kind); };
    tailer.drain();
    const status = tailer.status(); status.reason = 'mutated';
    expect(tailer.status().reason).toBe('source-finality-unknown');
    expect(f.usage()).toHaveLength(1);
  });

  it('does not install a timer after a synchronous stop during the initial record callback', () => {
    const f = fixture(); f.insert(1);
    const deps = f.deps();
    const record = deps.recorder.reconcile;
    const tailer = createCliUsageTailer(deps);
    deps.recorder.reconcile = (event, kind) => {
      tailer.start();
      tailer.stop();
      return record(event, kind);
    };
    tailer.start();
    f.insert(2); f.fire();
    expect(f.usage()).toHaveLength(1);
    expect(f.scheduler.clearInterval).not.toHaveBeenCalled();
  });

  it('rejects misattributed rows and continues past incomplete source rows without pretending completion', () => {
    const f = fixture(); f.insert(1); f.insert(2); f.insert(3);
    f.source.exec('UPDATE assistant_usage_events SET total_nano_aiu=NULL WHERE id=1');
    const deps = f.deps();
    const tailer = createCliUsageTailer(deps);
    expect(tailer.drain()).toMatchObject({ status: 'retrying', reason: 'source-values-not-ready', cursor: '2' });
    expect(f.usage()).toHaveLength(1);
    tailer.drain();
    expect(f.usage()).toHaveLength(2);
    f.source.exec('UPDATE assistant_usage_events SET total_nano_aiu=4000000000 WHERE id=1');
    tailer.drain();
    expect(f.usage().map((e) => e.credits)).toEqual([1, 1, 4]);
    const page = deps.read(null, 1);
    if (page.status !== 'ready') throw new Error('fixture');
    page.rows[0].event.sessionId = 'other-session';
    deps.read = () => page;
    expect(tailer.drain()).toMatchObject({ status: 'unsupported', reason: 'source-session-mismatch' });
  });

  it('uses the native scheduler and stops its polling', () => {
    vi.useFakeTimers();
    const f = fixture();
    const deps = f.deps(); delete deps.scheduler;
    const tailer = createCliUsageTailer(deps);
    tailer.start(); f.insert(1); vi.advanceTimersByTime(10);
    expect(f.usage()).toHaveLength(1);
    tailer.stop(); f.insert(2); vi.advanceTimersByTime(10);
    expect(f.usage()).toHaveLength(1);
  });
});
