import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createCliUsageStore,
  toUsageEvent,
  type CliUsageRow,
} from './cli-usage-store.js';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = join(process.cwd(), `.usage-store-fixture-${randomUUID()}`);
  mkdirSync(dir);
  dbPath = join(dir, 'session-store.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, total_nano_aiu INTEGER,
      request_multiplier REAL, created_at TEXT
    );
    -- Two requests for s1 sharing turn_index 1; ordered by id.
    INSERT INTO assistant_usage_events VALUES
      (10, 's1', 1, 'claude-opus-4.7', 100, 20, 5, 3000000000, 7.5, '2025-01-01T00:00:01Z'),
      (11, 's1', 1, 'claude-opus-4.7', 200, 40, 0, 5000000000, 7.5, '2025-01-01T00:00:02Z');
    -- s2 with a NULL model and NULL/text numeric fields -> coerced to 0.
    INSERT INTO assistant_usage_events VALUES
      (12, 's2', 0, NULL, NULL, NULL, NULL, 'NaN', NULL, '2025-01-02T00:00:00Z');
  `);
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createCliUsageStore', () => {
  it('reports availability from the file on disk', () => {
    expect(createCliUsageStore({ databasePath: dbPath }).available()).toBe(true);
    expect(
      createCliUsageStore({ databasePath: join(dir, 'missing.db') }).available(),
    ).toBe(false);
  });

  it('lists a session usage rows with a stable 0-based ordinal turnIndex', () => {
    const store = createCliUsageStore({ databasePath: dbPath });
    const rows = store.listBySession('s1');
    expect(rows).toEqual([
      {
        sessionId: 's1',
        turnIndex: 0,
        model: 'claude-opus-4.7',
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        totalNanoAiu: 3000000000,
        requestMultiplier: 7.5,
        createdAt: '2025-01-01T00:00:01Z',
      },
      {
        sessionId: 's1',
        turnIndex: 1,
        model: 'claude-opus-4.7',
        inputTokens: 200,
        outputTokens: 40,
        reasoningTokens: 0,
        totalNanoAiu: 5000000000,
        requestMultiplier: 7.5,
        createdAt: '2025-01-01T00:00:02Z',
      },
    ]);
  });

  it('does not invent zero-cost usage from NULL/non-numeric fields', () => {
    const store = createCliUsageStore({ databasePath: dbPath });
    expect(() => store.listBySession('s2')).toThrow('source-values-not-ready');
    expect(store.readUsagePage('s2', ctx, null, 5)).toMatchObject({ status: 'ready', rows: [], issue: { status: 'retrying', reason: 'source-values-not-ready' } });
  });

  it('returns empty for a session with no rows', () => {
    const store = createCliUsageStore({ databasePath: dbPath });
    expect(store.listBySession('nope')).toEqual([]);
  });

  it('reports missing sources explicitly', () => {
    const store = createCliUsageStore({ databasePath: join(dir, 'missing.db') });
    expect(() => store.listBySession('s1')).toThrow('source-missing');
    expect(store.readUsagePage('s1', ctx, null, 5)).toMatchObject({ status: 'retrying', reason: 'source-missing' });
  });

  it('reports invalid databases as a retryable read failure', () => {
    const badPath = join(dir, 'corrupt.db');
    writeFileSync(badPath, 'not a sqlite database');
    const store = createCliUsageStore({ databasePath: badPath });
    expect(() => store.listBySession('s1')).toThrow();
    expect(store.readUsagePage('s1', ctx, null, 5)).toMatchObject({ status: 'retrying', reason: 'source-read-failed' });
  });

  it('reports databases which cannot be opened', () => {
    const store = createCliUsageStore({ databasePath: dir });
    expect(() => store.listBySession('s1')).toThrow();
    expect(store.readUsagePage('s1', ctx, null, 5)).toMatchObject({ status: 'retrying', reason: 'source-read-failed' });
  });
});

describe('createCliUsageStore with sub-agent rows', () => {
  let subDir: string;
  let subDbPath: string;

  beforeAll(() => {
    subDir = join(process.cwd(), `.usage-store-fixture-${randomUUID()}`);
    mkdirSync(subDir);
    subDbPath = join(subDir, 'session-store.db');
    const db = new DatabaseSync(subDbPath);
    db.exec(`
      CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
        parent_tool_call_id TEXT,
        model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        reasoning_tokens INTEGER, total_nano_aiu INTEGER,
        request_multiplier REAL, created_at TEXT
      );
      -- Two primary-agent rows (parent NULL) and one nested sub-agent row.
      INSERT INTO assistant_usage_events
        (id, session_id, turn_index, parent_tool_call_id, model, input_tokens,
         output_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, created_at)
      VALUES
        (1, 's1', 0, NULL, 'gpt-5.3-codex', 100, 20, 5, 3000000000, 1, '2025-01-01T00:00:01Z'),
        (2, 's1', 1, 'tool_abc', 'gpt-5.3-codex', 999, 99, 9, 9000000000, 1, '2025-01-01T00:00:02Z'),
        (3, 's1', 2, NULL, 'gpt-5.3-codex', 200, 40, 0, 5000000000, 1, '2025-01-01T00:00:03Z');
    `);
    db.close();
  });

  afterAll(() => {
    rmSync(subDir, { recursive: true, force: true });
  });

  it('excludes nested sub-agent rows so totals match the CLI figure', () => {
    const store = createCliUsageStore({ databasePath: subDbPath });
    const rows = store.listBySession('s1');
    expect(rows.map((r) => r.totalNanoAiu)).toEqual([3000000000, 5000000000]);
    expect(rows.map((r) => r.turnIndex)).toEqual([0, 1]);
    const page = store.readUsagePage('s1', ctx, null, 1);
    expect(page).toMatchObject({ status: 'ready', nextCursor: '1', final: false });
    const next = store.readUsagePage('s1', ctx, '1', 1);
    expect(next).toMatchObject({ status: 'ready', nextCursor: null, rows: [{ sourceKey: '[3,"2025-01-01T00:00:03Z"]' }] });
  });
});

const ctx = { featureId: 'f1', provider: 'agency', requestedModel: 'auto' };

describe('incremental source reads', () => {
  it('distinguishes a real exclusive lock from an empty source and succeeds after release', () => {
    const writer = new DatabaseSync(dbPath);
    const store = createCliUsageStore({ databasePath: dbPath });
    try {
      writer.exec('BEGIN EXCLUSIVE');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'retrying', reason: 'source-locked' });
      writer.exec('ROLLBACK');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', rows: [{ event: { cost: 3 } }] });
    } finally { writer.close(); }
  });

  it.each([new Error('encoding'), undefined])('does not disguise an unexpected row conversion failure as a partial successful page (%s)', (error) => {
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw error; });
    let result;
    try { result = createCliUsageStore({ databasePath: dbPath }).readUsagePage('s1', ctx, null, 1); }
    finally { stringify.mockRestore(); }
    expect(result).toMatchObject({ status: 'retrying', reason: 'source-read-failed' });
  });

  it('bounds mapped rows, retains provider identities rather than turn_index and never claims EOF finality', () => {
    const before = readFileSync(dbPath);
    const store = createCliUsageStore({ databasePath: dbPath });
    expect(store.sourceId).toBe(dbPath);
    expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({
      status: 'ready', nextCursor: '10', final: false,
      rows: [{ sourceKey: '[10,"2025-01-01T00:00:01Z"]', event: { cost: 3 } }],
    });
    expect(store.readUsagePage('s1', ctx, '10', 1)).toMatchObject({
      status: 'ready', nextCursor: null, final: false,
      rows: [{ sourceKey: '[11,"2025-01-01T00:00:02Z"]', event: { cost: 5 } }],
    });
    expect(store.readUsagePage('s1', ctx, '11', 1)).toMatchObject({ status: 'ready', rows: [], final: false });
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it.each([[null, 0], [null, 1001], [null, 1.5], ['no', 1], ['9007199254740992', 1]] as const)(
    'rejects invalid cursor/limit %s/%s', (cursor, limit) => {
      expect(createCliUsageStore({ databasePath: dbPath }).readUsagePage('s1', ctx, cursor, limit))
        .toMatchObject({ status: 'unsupported', reason: 'invalid-capture-cursor' });
    },
  );

  it('distinguishes not-ready, unsupported schemas, and invalid identities', () => {
    const path = join(dir, 'schema.db');
    const db = new DatabaseSync(path);
    const store = createCliUsageStore({ databasePath: path });
    try {
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'retrying', reason: 'source-not-ready' });
      db.exec('CREATE TABLE assistant_usage_events (id TEXT PRIMARY KEY)');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'unsupported', reason: 'source-schema-unsupported' });
      db.exec('DROP TABLE assistant_usage_events; CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY)');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'unsupported', reason: 'source-schema-unsupported' });
      db.exec(`DROP TABLE assistant_usage_events;
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT,
          input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
          total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT);
        INSERT INTO assistant_usage_events VALUES (1,'s1',NULL,1,1,0,0,1,NULL)`);
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', issue: { status: 'unsupported', reason: 'source-identity-unsupported' } });
      db.exec("UPDATE assistant_usage_events SET created_at=''");
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', issue: { status: 'unsupported', reason: 'source-identity-unsupported' } });
      db.exec("UPDATE assistant_usage_events SET created_at='t', total_nano_aiu='NaN'");
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', issue: { status: 'retrying', reason: 'source-values-not-ready' } });
      db.exec('UPDATE assistant_usage_events SET total_nano_aiu=-1');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', issue: { status: 'retrying', reason: 'source-values-not-ready' } });
      db.exec('UPDATE assistant_usage_events SET total_nano_aiu=0');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', rows: [{ event: { cost: 0, resolvedModel: 'auto' } }] });
      db.exec('UPDATE assistant_usage_events SET total_nano_aiu=4000000000, request_multiplier=NULL');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', rows: [{ event: { cost: 4 } }] });
      db.exec('ALTER TABLE assistant_usage_events DROP COLUMN request_multiplier');
      expect(store.readUsagePage('s1', ctx, null, 1)).toMatchObject({ status: 'ready', rows: [{ event: { cost: 4 } }] });
    } finally { db.close(); }
  });
});

describe('toUsageEvent', () => {
  const base: CliUsageRow = {
    sessionId: 's1',
    turnIndex: 3,
    model: 'claude-opus-4.7',
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    totalNanoAiu: 3_000_000_000,
    requestMultiplier: 7.5,
    createdAt: '2025-01-01T00:00:01Z',
  };
  const ctx = { featureId: 'f1', provider: 'agency', requestedModel: 'auto' };

  it('maps a row to a canonical UsageEvent with AIC-denominated cost', () => {
    expect(toUsageEvent(base, ctx)).toEqual({
      sessionId: 's1',
      featureId: 'f1',
      turnIndex: 3,
      provider: 'agency',
      requestedModel: 'auto',
      resolvedModel: 'claude-opus-4.7',
      operation: 'chat',
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      cost: 3,
      nanoAiu: 3_000_000_000,
      serviceRequestId: null,
      startedAt: '2025-01-01T00:00:01Z',
      endedAt: '2025-01-01T00:00:01Z',
    });
  });

  it('falls back to the requested model when the row has no model', () => {
    expect(toUsageEvent({ ...base, model: null }, ctx).resolvedModel).toBe('auto');
  });
});
