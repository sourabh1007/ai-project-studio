import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../persistence/db/connection.js';
import { createClientOperationRepo } from '../persistence/client-operation-repo.js';
import { createSqliteUnitOfWork } from '../persistence/sqlite-unit-of-work.js';
import { UnitOfWorkUncertainError, type UnitOfWork } from '../persistence/unit-of-work.js';
import { createClientOperations } from './client-operations-service.js';
import { clientOperationsDefaults, type ClientOperationsConfig } from './config.js';
import type { ClientOperationRepo } from './client-operations-contract.js';

function setup(options: {
  db?: DatabaseSync;
  config?: Partial<ClientOperationsConfig>;
  unitOfWork?: (db: DatabaseSync) => UnitOfWork;
  repo?: (real: ClientOperationRepo) => ClientOperationRepo;
  nowMs?: { value: number };
} = {}) {
  const db = options.db ?? createDatabase({ databasePath: ':memory:' });
  const real = createClientOperationRepo(db);
  const now = options.nowMs ?? { value: 1_000 };
  const repo = options.repo ? options.repo(real) : real;
  const ops = createClientOperations({
    repo,
    unitOfWork: options.unitOfWork ? options.unitOfWork(db) : createSqliteUnitOfWork(db),
    clock: { now: () => new Date(now.value), isoNow: () => new Date(now.value).toISOString() },
    config: { ...clientOperationsDefaults, ...options.config },
  });
  return { db, ops, repo: real, now };
}

const ok = { status: 201, body: { id: 'r1' } };
const healthy = { nested: false, poisoned: false };
const hashOf = (fingerprint: unknown): string => createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
const run = (ops: ReturnType<typeof setup>['ops'], key: string | null, fingerprint: unknown, write: () => typeof ok = () => ok) =>
  ops.run({ scope: 's', key, fingerprint }, async (commit) => { commit(write); });

describe('keyFrom', () => {
  const { ops } = setup();
  it('returns null when absent and the token when valid', () => {
    expect(ops.keyFrom(undefined)).toBeNull();
    expect(ops.keyFrom({})).toBeNull();
    expect(ops.keyFrom({ 'idempotency-key': 'abc-123_X.y:z~' })).toBe('abc-123_X.y:z~');
  });
  it.each([[''], ['has space'], ['x'.repeat(129)], [['a', 'b']]])('rejects %j', (value) => {
    expect(() => ops.keyFrom({ 'idempotency-key': value as string })).toThrow(/Invalid operation key/);
  });
});

describe('run without a key', () => {
  it('executes every time with no record', async () => {
    const { ops, repo } = setup();
    await run(ops, null, {});
    await run(ops, null, {});
    expect(repo.count()).toBe(0);
  });
  it('fails when execute never commits', async () => {
    const { ops } = setup();
    await expect(ops.run({ scope: 's', key: null, fingerprint: {} }, async () => {})).rejects.toThrow(/without committing/);
  });
});

describe('run with a key', () => {
  it('replays the stored result for the same key and canonical-equal input', async () => {
    const { ops } = setup();
    let writes = 0;
    const first = await run(ops, 'k1', { a: 1, b: [1, { c: undefined, d: 2 }] }, () => { writes++; return ok; });
    const retry = await run(ops, 'k1', { b: [1, { d: 2 }], a: 1 }, () => { writes++; return ok; });
    expect(retry).toEqual(first);
    expect(writes).toBe(1);
  });

  it('accepts an undefined fingerprint', async () => {
    const { ops } = setup();
    expect(await run(ops, 'k0', undefined)).toEqual(ok);
  });

  it('keeps scopes separate', async () => {
    const { ops } = setup();
    let writes = 0;
    await ops.run({ scope: 'a', key: 'k', fingerprint: 1 }, async (c) => { c(() => { writes++; return ok; }); });
    await ops.run({ scope: 'b', key: 'k', fingerprint: 1 }, async (c) => { c(() => { writes++; return ok; }); });
    expect(writes).toBe(2);
  });

  it('survives a restart: a new service over the same database replays', async () => {
    const first = setup();
    await run(first.ops, 'k2', 'x');
    const restarted = setup({ db: first.db });
    let writes = 0;
    expect(await run(restarted.ops, 'k2', 'x', () => { writes++; return ok; })).toEqual(ok);
    expect(writes).toBe(0);
  });

  it('conflicts on different input for a stored key and for an in-flight key', async () => {
    const { ops } = setup();
    await run(ops, 'k3', 1);
    await expect(run(ops, 'k3', 2)).rejects.toMatchObject({ kind: 'conflict', details: { code: 'operation_key_conflict' } });

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = ops.run({ scope: 's', key: 'k4', fingerprint: 1 }, async (c) => { await gate; c(() => ok); });
    await expect(run(ops, 'k4', 2)).rejects.toMatchObject({ kind: 'conflict' });
    release();
    await slow;
  });

  it('shares one execution between concurrent same-key calls, including its failure', async () => {
    const { ops, repo } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let writes = 0;
    const exec = async (c: (w: () => typeof ok) => unknown) => { await gate; c(() => { writes++; return ok; }); };
    const a = ops.run({ scope: 's', key: 'k5', fingerprint: 1 }, exec);
    const b = ops.run({ scope: 's', key: 'k5', fingerprint: 1 }, exec);
    release();
    expect(await a).toEqual(await b);
    expect(writes).toBe(1);

    const failing = async () => { await gate; throw new Error('boom'); };
    const c = ops.run({ scope: 's', key: 'k6', fingerprint: 1 }, failing);
    const d = ops.run({ scope: 's', key: 'k6', fingerprint: 1 }, failing);
    await expect(c).rejects.toThrow('boom');
    await expect(d).rejects.toThrow('boom');
    expect(repo.get('s', 'k6')).toBeUndefined();
  });

  it('reserves the durable record before the first await', () => {
    const { ops, repo } = setup();
    void ops.run({ scope: 's', key: 'early', fingerprint: 1 }, () => new Promise(() => {}));
    expect(repo.get('s', 'early')?.state).toBe('pending');
  });

  it('resumes a pending key left by a crashed process and writes exactly once', async () => {
    const { repo, db } = setup();
    repo.reservePending('s', 'orphan', hashOf(1), 1);
    const restarted = setup({ db });
    let writes = 0;
    expect(await run(restarted.ops, 'orphan', 1, () => { writes++; return ok; })).toEqual(ok);
    expect(await run(restarted.ops, 'orphan', 1, () => { writes++; return ok; })).toEqual(ok);
    expect(writes).toBe(1);
    expect(repo.get('s', 'orphan')?.state).toBe('succeeded');
  });

  it('conflicts when a pending key is retried with different input', async () => {
    const { repo, db } = setup();
    repo.reservePending('s', 'orphan2', hashOf(1), 1);
    const restarted = setup({ db });
    await expect(run(restarted.ops, 'orphan2', 2)).rejects.toMatchObject({ details: { code: 'operation_key_conflict' } });
    expect(repo.get('s', 'orphan2')?.state).toBe('pending');
  });

  it('paused executor A and resumed service B on one database commit exactly one resource', async () => {
    const first = setup();
    first.db.exec('CREATE TABLE res (id TEXT)');
    const second = setup({ db: first.db });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let aWrites = 0;
    const a = first.ops.run({ scope: 's', key: 'race', fingerprint: 1 }, async (commit) => {
      await gate;
      commit(() => { aWrites++; first.db.exec("INSERT INTO res VALUES ('a')"); return ok; });
    });
    let bWrites = 0;
    const b = await second.ops.run({ scope: 's', key: 'race', fingerprint: 1 }, async (commit) => {
      commit(() => { bWrites++; first.db.exec("INSERT INTO res VALUES ('b')"); return { status: 201, body: { id: 'b' } }; });
    });
    release();
    const replayed = await a;
    expect(b.body).toEqual({ id: 'b' });
    expect(replayed).toEqual(b);
    expect([aWrites, bWrites]).toEqual([0, 1]);
    expect(first.db.prepare('SELECT COUNT(*) AS n FROM res').get()).toEqual({ n: 1 });
  });

  it('does not write when the reservation disappeared or now belongs to different input', async () => {
    const { ops, repo, db } = setup();
    let writes = 0;
    const gate = { release: () => {} };
    const pause = new Promise<void>((r) => { gate.release = r; });
    const slow = ops.run({ scope: 's', key: 'lost', fingerprint: 1 }, async (commit) => {
      await pause;
      commit(() => { writes++; return ok; });
    });
    db.exec("DELETE FROM client_operations WHERE op_key = 'lost'");
    gate.release();
    await expect(slow).rejects.toMatchObject({ kind: 'conflict', details: { code: 'operation_pending' } });

    const pause2 = new Promise<void>((r) => { gate.release = r; });
    const replaced = ops.run({ scope: 's', key: 'lost2', fingerprint: 1 }, async (commit) => {
      await pause2;
      commit(() => { writes++; return ok; });
    });
    db.exec("UPDATE client_operations SET request_hash = 'other' WHERE op_key = 'lost2'");
    gate.release();
    await expect(replaced).rejects.toMatchObject({ details: { code: 'operation_pending' } });
    expect(writes).toBe(0);
    expect(repo.get('s', 'lost2')?.requestHash).toBe('other');
  });

  it('releases the key when the write is rolled back so the same key can retry', async () => {
    const { ops, repo } = setup();
    await expect(run(ops, 'k7', 1, () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    expect(repo.get('s', 'k7')).toBeUndefined();
    expect((await run(ops, 'k7', 1)).status).toBe(201);
  });

  it('releases the key when execution fails before any write', async () => {
    const { ops, repo } = setup();
    await expect(ops.run({ scope: 's', key: 'k8', fingerprint: 1 }, async () => { throw new Error('resolve'); })).rejects.toThrow('resolve');
    expect(repo.get('s', 'k8')).toBeUndefined();
  });

  it('keeps the record when releasing a failed key itself fails', async () => {
    const { ops, repo } = setup({ repo: (real) => ({ ...real, releasePending: () => { throw new Error('locked'); } }) });
    await expect(run(ops, 'k9', 1, () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    expect(repo.get('s', 'k9')?.state).toBe('pending');
  });

  it('releases and errors when execute finishes without committing', async () => {
    const { ops, repo } = setup();
    await expect(ops.run({ scope: 's', key: 'k10', fingerprint: 1 }, async () => {})).rejects.toThrow(/without committing/);
    expect(repo.get('s', 'k10')).toBeUndefined();
  });

  it('keeps the record protected when the commit outcome is uncertain', async () => {
    const { ops, repo } = setup({
      unitOfWork: () => ({ ...healthy, run: () => { throw new UnitOfWorkUncertainError(new Error('disk')); } }),
    });
    let attempts = 0;
    await expect(run(ops, 'k11', 1, () => { attempts++; return ok; })).rejects.toBeInstanceOf(UnitOfWorkUncertainError);
    expect(repo.get('s', 'k11')?.state).toBe('pending');
    await expect(ops.run({ scope: 's', key: 'k12', fingerprint: 1 }, async (c) => { try { c(() => ok); } catch { /* swallowed */ } }))
      .rejects.toThrow(/without committing/);
    expect(repo.get('s', 'k12')?.state).toBe('pending');
    await expect(run(ops, 'k11', 1)).rejects.toBeInstanceOf(UnitOfWorkUncertainError);
    expect(attempts).toBe(0);
    expect(repo.get('s', 'k11')?.state).toBe('pending');
  });

  it('returns the committed result even if execute throws afterwards', async () => {
    const { ops } = setup();
    const result = await ops.run({ scope: 's', key: 'k13', fingerprint: 1 }, async (c) => { c(() => ok); throw new Error('late'); });
    expect(result).toEqual(ok);
  });

  it('rolls back the write when the success record cannot be stored', async () => {
    const { ops, repo } = setup({ repo: (real) => ({ ...real, complete: () => false }) });
    let written = false;
    await expect(run(ops, 'k14', 1, () => { written = true; return ok; })).rejects.toThrow(/not pending/);
    expect(written).toBe(true);
    expect(repo.get('s', 'k14')).toBeUndefined();
  });

  it('commits the resource write and the record atomically', async () => {
    const { ops, db } = setup();
    db.exec('CREATE TABLE res (id TEXT)');
    await run(ops, 'k15', 1, () => { db.exec("INSERT INTO res VALUES ('a')"); return ok; });
    expect(db.prepare('SELECT COUNT(*) AS n FROM res').get()).toEqual({ n: 1 });
    await expect(run(ops, 'k16', 1, () => { db.exec("INSERT INTO res VALUES ('b')"); throw new Error('x'); })).rejects.toThrow('x');
    expect(db.prepare('SELECT COUNT(*) AS n FROM res').get()).toEqual({ n: 1 });
  });
});

describe('retention and capacity', () => {
  it('prunes only expired succeeded records, never pending ones', async () => {
    const { ops, repo, now } = setup({ config: { retentionMs: 100, pruneBatch: 10 } });
    await run(ops, 'old', 1);
    void ops.run({ scope: 's', key: 'stuck', fingerprint: 1 }, () => new Promise(() => {}));
    now.value += 1_000;
    await run(ops, 'new', 1);
    expect(repo.get('s', 'old')).toBeUndefined();
    expect(repo.get('s', 'stuck')?.state).toBe('pending');
    expect(repo.get('s', 'new')?.state).toBe('succeeded');
  });

  it('rejects explicitly at capacity without evicting unresolved or unexpired records', async () => {
    const { ops, repo } = setup({ config: { maxRecords: 2 } });
    void ops.run({ scope: 's', key: 'p1', fingerprint: 1 }, () => new Promise(() => {}));
    await run(ops, 'done', 1);
    await expect(run(ops, 'extra', 1)).rejects.toMatchObject({ kind: 'unavailable', details: { code: 'operation_capacity' } });
    expect(repo.count()).toBe(2);
    expect(repo.get('s', 'p1')?.state).toBe('pending');
    expect(await run(ops, 'done', 1)).toEqual(ok);
  });

  it('frees capacity once records expire', async () => {
    const { ops, now } = setup({ config: { maxRecords: 1, retentionMs: 10 } });
    await run(ops, 'a', 1);
    now.value += 100;
    await expect(run(ops, 'b', 1)).resolves.toEqual(ok);
  });
});

describe('quarantine and nested transactions', () => {
  it('refuses every operation, including replays, once the connection is poisoned', async () => {
    let poisoned = false;
    const { ops, repo } = setup({
      unitOfWork: (db) => {
        const real = createSqliteUnitOfWork(db);
        return { run: (fn) => real.run(fn), nested: false, get poisoned() { return poisoned; } };
      },
    });
    await run(ops, 'done', 1);
    poisoned = true;
    let writes = 0;
    await expect(run(ops, 'done', 1)).rejects.toMatchObject({ kind: 'unavailable', details: { code: 'operation_connection_unhealthy' } });
    await expect(run(ops, 'fresh', 1, () => { writes++; return ok; })).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(run(ops, null, 1, () => { writes++; return ok; })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(writes).toBe(0);
    expect(repo.get('s', 'fresh')).toBeUndefined();
  });

  it('keeps the pending record and does not touch the poisoned connection when poisoned mid-flight', async () => {
    let poisoned = false;
    const { ops, repo } = setup({
      unitOfWork: (db) => ({ ...createSqliteUnitOfWork(db), nested: false, get poisoned() { return poisoned; } }),
    });
    let released = false;
    const guarded = setup({
      db: undefined,
      repo: (real) => ({ ...real, releasePending: () => { released = true; } }),
      unitOfWork: () => ({ run: (fn) => fn(), nested: false, get poisoned() { return poisoned; } }),
    });
    await expect(guarded.ops.run({ scope: 's', key: 'mid', fingerprint: 1 }, async (commit) => {
      poisoned = true;
      commit(() => ok);
    })).rejects.toMatchObject({ details: { code: 'operation_connection_unhealthy' } });
    expect(released).toBe(false);
    expect(guarded.repo.get('s', 'mid')?.state).toBe('pending');
    expect(ops).toBeDefined();
    expect(repo.count()).toBe(0);
  });

  it('refuses to commit inside an enclosing transaction and releases the unwritten key', async () => {
    const { ops, repo } = setup({ unitOfWork: () => ({ run: (fn) => fn(), nested: true, poisoned: false }) });
    let writes = 0;
    await expect(run(ops, 'nest', 1, () => { writes++; return ok; })).rejects.toThrow(/inside another transaction/);
    expect(writes).toBe(0);
    expect(repo.get('s', 'nest')).toBeUndefined();
  });
});