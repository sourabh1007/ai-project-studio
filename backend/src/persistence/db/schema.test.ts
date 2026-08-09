import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from './connection.js';
import { applySchema } from './schema.js';

/** Table names across the primary and every attached database. */
function allTables(db: DatabaseSync): string[] {
  const schemas = (db.prepare('PRAGMA database_list').all() as { name: string }[]).map(
    (r) => r.name,
  );
  return schemas.flatMap((schema) =>
    (
      db
        .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`)
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
}

/** Index names (idx_*) across the primary and every attached database. */
function allIndexes(db: DatabaseSync): string[] {
  const schemas = (db.prepare('PRAGMA database_list').all() as { name: string }[]).map(
    (r) => r.name,
  );
  return schemas.flatMap((schema) =>
    (
      db
        .prepare(
          `SELECT name FROM ${schema}.sqlite_master WHERE type='index' AND name LIKE 'idx_%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
}

function sessionColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function skillsColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function featureColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(features)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe('db schema/connection', () => {
  it('creates all expected tables', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const tables = allTables(db);
    db.close();
    expect(tables).toEqual(
      expect.arrayContaining([
        'features',
        'sessions',
        'feature_groups',
        'usage_events',
        'transcripts',
        'summaries',
        'session_summaries',
        'skills',
        'skill_attachments',
        'feature_tasks',
        'repositories',
        'repository_contexts',
        'context_documents',
        'config_overrides',
      ]),
    );
  });

  it('partitions high-volume tables into sibling database files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aps-db-split-'));
    try {
      const db = createDatabase({ databasePath: join(dir, 'workspace.db') });
      // The core catalog stays in the primary file; append-heavy data moves out.
      const mainTables = (
        db
          .prepare("SELECT name FROM main.sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(mainTables).toContain('features');
      expect(mainTables).toContain('repository_contexts');
      expect(mainTables).not.toContain('usage_events');
      expect(mainTables).not.toContain('feature_tasks');
      db.close();
      // Each group is its own physical file.
      expect(existsSync(join(dir, 'usage.db'))).toBe(true);
      expect(existsSync(join(dir, 'content.db'))).toBe(true);
      expect(existsSync(join(dir, 'tasks.db'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates indexes backing hot foreign-key lookups', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const indexes = allIndexes(db);
    db.close();
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_sessions_feature_id',
        'idx_feature_groups_feature_id',
        'idx_features_repo_id',
        'idx_usage_events_feature_id',
        'idx_skill_attachments_skill_id',
        'idx_skill_attachments_target',
        'idx_feature_tasks_feature_id',
      ]),
    );
  });

  it('is idempotent when applied twice', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('relocates a legacy monolithic table into its sibling database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aps-db-relocate-'));
    try {
      const databasePath = join(dir, 'workspace.db');
      // Simulate an older single-file database that predates the split: the
      // partitioned tables still live in the primary file with real data.
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`CREATE TABLE usage_events (
        session_id TEXT NOT NULL,
        feature_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        resolved_model TEXT NOT NULL,
        operation TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_output_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        credits REAL NOT NULL,
        nano_aiu INTEGER NOT NULL,
        service_request_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_index)
      )`);
      legacy.prepare(
        `INSERT INTO usage_events VALUES
         ('s1','f1',0,'dev','copilot','auto','auto','chat',1,2,0,0.5,1.0,10,NULL,'now','now')`,
      ).run();
      legacy.close();

      const db = createDatabase({ databasePath });
      // The legacy copy is gone from the primary file...
      const inMain = db
        .prepare(
          "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='usage_events'",
        )
        .get();
      expect(inMain).toBeUndefined();
      // ...and its row now lives in the usage sibling database.
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM usage.usage_events').get(),
      ).toEqual({ n: 1 });
      expect(
        (db.prepare('SELECT feature_id FROM usage_events').get() as {
          feature_id: string;
        }).feature_id,
      ).toBe('f1');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the sessions.name column to a legacy database', () => {
    const db = new DatabaseSync(':memory:');
    // A pre-name-feature sessions table, missing the `name` column.
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      usage_file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER
    )`);
    expect(sessionColumns(db)).not.toContain('name');
    applySchema(db);
    expect(sessionColumns(db)).toContain('name');
    // Idempotent: applying again does not attempt to re-add the column.
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('adds feature scope to legacy sessions so they remain visible', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      usage_file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      name TEXT
    )`);
    db.exec(`INSERT INTO sessions
      (id, feature_id, provider, requested_model, status, kind, prompt,
       usage_file_path, created_at)
      VALUES ('s1', 'f1', 'copilot', 'auto', 'completed', 'dev', 'p', 'u', 'now')`);

    applySchema(db);
    expect(sessionColumns(db)).toContain('scope');
    expect(db.prepare("SELECT scope FROM sessions WHERE id = 's1'").get()).toEqual({
      scope: 'feature',
    });
    db.close();
  });

  it('adds tree placement columns to legacy sessions', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      usage_file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      name TEXT
    )`);
    db.exec(`INSERT INTO sessions
      (id, feature_id, provider, requested_model, status, kind, prompt,
       usage_file_path, created_at)
      VALUES ('s1', 'f1', 'copilot', 'auto', 'completed', 'dev', 'p', 'u', 'now')`);

    expect(sessionColumns(db)).not.toContain('group_id');
    applySchema(db);
    expect(sessionColumns(db)).toContain('group_id');
    expect(sessionColumns(db)).toContain('order_index');
    expect(
      db.prepare("SELECT group_id, order_index FROM sessions WHERE id = 's1'").get(),
    ).toEqual({ group_id: null, order_index: 0 });
    db.close();
  });

  it('adds the skills.removal_instructions column to a legacy database', () => {
    const db = new DatabaseSync(':memory:');
    // A pre-removal-reaction skills table, missing the new column.
    db.exec(`CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    expect(skillsColumns(db)).not.toContain('removal_instructions');
    applySchema(db);
    expect(skillsColumns(db)).toContain('removal_instructions');
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('adds the skills.recommended_scope column to a legacy database', () => {
    const db = new DatabaseSync(':memory:');
    // A pre-recommended-scope skills table, missing the new column.
    db.exec(`CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      instructions TEXT NOT NULL,
      removal_instructions TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`);
    expect(skillsColumns(db)).not.toContain('recommended_scope');
    applySchema(db);
    expect(skillsColumns(db)).toContain('recommended_scope');
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('adds the features.repo_id column to a legacy database', () => {
    const db = new DatabaseSync(':memory:');
    // A pre-repository features table, missing the `repo_id` column.
    db.exec(`CREATE TABLE features (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT
    )`);
    expect(featureColumns(db)).not.toContain('repo_id');
    applySchema(db);
    expect(featureColumns(db)).toContain('repo_id');
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('adds the features.order_index column to a legacy database', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE features (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT
    )`);
    db.exec(
      "INSERT INTO features (id, name, description, created_at) VALUES ('f1', 'Login', 'd', 'now')",
    );
    expect(featureColumns(db)).not.toContain('order_index');
    applySchema(db);
    expect(featureColumns(db)).toContain('order_index');
    expect(
      db.prepare("SELECT order_index FROM features WHERE id = 'f1'").get(),
    ).toEqual({ order_index: 0 });
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('adds failure_step and steps columns to a legacy repository_contexts table', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      default_branch TEXT,
      created_at TEXT NOT NULL
    )`);
    // A pre-step-tracking repository_contexts table.
    db.exec(`CREATE TABLE repository_contexts (
      repo_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      content TEXT,
      source_revision TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generation_started_at TEXT,
      generated_at TEXT,
      failure_code TEXT,
      failure_message TEXT,
      failed_at TEXT,
      failure_retryable INTEGER
    )`);
    db.exec(`INSERT INTO repository_contexts
      (repo_id, status, created_at, updated_at)
      VALUES ('r1', 'ready', 'now', 'now')`);

    applySchema(db);
    const columns = (
      db.prepare('PRAGMA table_info(repository_contexts)').all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns).toContain('failure_step');
    expect(columns).toContain('steps');
    expect(
      db.prepare("SELECT steps FROM repository_contexts WHERE repo_id = 'r1'").get(),
    ).toEqual({ steps: '[]' });
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });
});
