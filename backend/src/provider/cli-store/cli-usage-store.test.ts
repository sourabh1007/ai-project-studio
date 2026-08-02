import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCliUsageStore,
  toUsageEvent,
  type CliUsageRow,
} from './cli-usage-store.js';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-usage-'));
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

  it('coerces NULL/non-numeric fields to 0 and keeps NULL model', () => {
    const store = createCliUsageStore({ databasePath: dbPath });
    const [row] = store.listBySession('s2');
    expect(row).toMatchObject({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalNanoAiu: 0,
      requestMultiplier: 0,
    });
  });

  it('returns empty for a session with no rows', () => {
    const store = createCliUsageStore({ databasePath: dbPath });
    expect(store.listBySession('nope')).toEqual([]);
  });

  it('returns empty when the file is missing', () => {
    const store = createCliUsageStore({ databasePath: join(dir, 'missing.db') });
    expect(store.listBySession('s1')).toEqual([]);
  });

  it('degrades to empty when the file is not a valid database', () => {
    const badPath = join(dir, 'corrupt.db');
    writeFileSync(badPath, 'not a sqlite database');
    const store = createCliUsageStore({ databasePath: badPath });
    expect(store.listBySession('s1')).toEqual([]);
  });

  it('degrades to empty when the store cannot be opened', () => {
    const store = createCliUsageStore({ databasePath: dir });
    expect(store.listBySession('s1')).toEqual([]);
  });
});

describe('createCliUsageStore with sub-agent rows', () => {
  let subDir: string;
  let subDbPath: string;

  beforeAll(() => {
    subDir = mkdtempSync(join(tmpdir(), 'cw-usage-sub-'));
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
