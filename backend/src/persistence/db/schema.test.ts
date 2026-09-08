import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import {
  applySchema,
  type ApplySchemaOptions,
  DATABASE_GROUPS,
  restoreMigrationBackup,
} from './schema.js';

const TEST_ROOT = join(process.cwd(), '.schema-test-work');
const LEGACY_USAGE_MIGRATION = 'relocate-usage-usage_events';
const LEGACY_AUTOMATION_RUNS_MIGRATION = 'relocate-automations-automation_runs';
const LEGACY_AUTOMATIONS_MIGRATION = 'rebuild-automations-needs-auth-status';

/** Table names across the primary and every attached database. */
function allTables(db: DatabaseSync): string[] {
  const schemas = (db.prepare('PRAGMA database_list').all() as { name: string }[]).map(
    (row) => row.name,
  );
  return schemas.flatMap((schema) =>
    (
      db
        .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`)
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
}

/** Index names (idx_*) across the primary and every attached database. */
function allIndexes(db: DatabaseSync): string[] {
  const schemas = (db.prepare('PRAGMA database_list').all() as { name: string }[]).map(
    (row) => row.name,
  );
  return schemas.flatMap((schema) =>
    (
      db
        .prepare(
          `SELECT name FROM ${schema}.sqlite_master WHERE type='index' AND name LIKE 'idx_%'`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
}

function sessionColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
    (column) => column.name,
  );
}

function skillsColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]).map(
    (column) => column.name,
  );
}

function featureColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(features)').all() as { name: string }[]).map(
    (column) => column.name,
  );
}

function automationRunColumns(db: DatabaseSync): string[] {
  return (
    db.prepare('PRAGMA automations.table_info(automation_runs)').all() as {
      name: string;
    }[]
  ).map((column) => column.name);
}

function usageCaptureStateColumns(db: DatabaseSync): string[] {
  return (
    db.prepare('PRAGMA usage.table_info(usage_capture_state)').all() as {
      name: string;
    }[]
  ).map((column) => column.name);
}

function makeWorkspaceDir(prefix: string): string {
  const dir = join(TEST_ROOT, `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function attachWorkspaceGroups(db: DatabaseSync, databasePath: string): void {
  const directory = dirname(databasePath);
  for (const group of DATABASE_GROUPS) {
    if (group.schema === 'main' || group.file === null) {
      continue;
    }
    db.prepare(`ATTACH DATABASE ? AS ${group.schema}`).run(join(directory, group.file));
  }
}

function openWorkspaceDatabase(databasePath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath);
  attachWorkspaceGroups(db, databasePath);
  return db;
}

function tableExists(db: DatabaseSync, schema: string, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name = ?`)
      .get(table) !== undefined
  );
}

function failAtStage(
  migrationId: string,
  stage: string,
  when: 'before' | 'after',
): ApplySchemaOptions {
  let injected = false;
  const maybeThrow = (
    info: { migrationId: string; stage: string },
    hookWhen: 'before' | 'after',
  ): void => {
    if (
      !injected &&
      hookWhen === when &&
      info.migrationId === migrationId &&
      info.stage === stage
    ) {
      injected = true;
      throw new Error(`Injected ${when} ${stage}`);
    }
  };
  return {
    stageHooks: {
      beforeStage(info) {
        maybeThrow(info, 'before');
      },
      afterStage(info) {
        maybeThrow(info, 'after');
      },
    },
  };
}

function readBackupPath(databasePath: string, migrationId: string): string {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db
      .prepare(
        'SELECT backup_path FROM schema_migrations WHERE migration_id = ?',
      )
      .get(migrationId) as { backup_path: string };
    return row.backup_path;
  } finally {
    db.close();
  }
}

function readMigrationRow(
  databasePath: string,
  migrationId: string,
): {
  status: string;
  active_stage: string | null;
  backup_path: string | null;
  last_error: string | null;
} {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare(
        `SELECT status, active_stage, backup_path, last_error
         FROM schema_migrations
         WHERE migration_id = ?`,
      )
      .get(migrationId) as {
      status: string;
      active_stage: string | null;
      backup_path: string | null;
      last_error: string | null;
    };
  } finally {
    db.close();
  }
}

function readStageRow(
  databasePath: string,
  migrationId: string,
  stage: string,
): { status: string; detail: string } | undefined {
  const db = new DatabaseSync(databasePath);
  try {
    return db
      .prepare(
        `SELECT status, detail
         FROM schema_migration_stages
         WHERE migration_id = ? AND stage = ?`,
      )
      .get(migrationId, stage) as { status: string; detail: string } | undefined;
  } finally {
    db.close();
  }
}

function setMigrationJournalState(
  databasePath: string,
  migrationId: string,
  state: {
    status: 'running' | 'failed';
    activeStage: string;
    lastError: string | null;
    stageStatus: 'running' | 'failed';
    stageDetail: string;
  },
): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      `UPDATE schema_migrations
       SET status = ?, active_stage = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE migration_id = ?`,
    ).run(state.status, state.activeStage, state.lastError, migrationId);
    db.prepare(
      `UPDATE schema_migration_stages
       SET status = ?, detail = ?, updated_at = CURRENT_TIMESTAMP
       WHERE migration_id = ? AND stage = ?`,
    ).run(state.stageStatus, state.stageDetail, migrationId, state.activeStage);
  } finally {
    db.close();
  }
}

function seedLegacyUsageEvents(databasePath: string): void {
  const legacy = new DatabaseSync(databasePath);
  try {
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
  } finally {
    legacy.close();
  }
}

function seedLegacyReviewTable(databasePath: string, populated: boolean): void {
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`CREATE TABLE pr_reviews (
      feature_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      pull_title TEXT NOT NULL,
      pull_url TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      base_branch TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      core_analysis TEXT,
      changed_files INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generated_at TEXT,
      failure_message TEXT,
      failed_at TEXT
    )`);
    if (populated) {
      legacy.exec(`INSERT INTO pr_reviews (
        feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
        base_branch, status, summary, core_analysis, changed_files,
        created_at, updated_at, generated_at, failure_message, failed_at
      ) VALUES (
        'feat-1', 'repo-1', 42, 'Legacy title', 'https://example.test/pr/42',
        'C:\\\\worktree', 'main', 'ready', 'Summary', 'Core', 7,
        'now', 'now', 'later', NULL, NULL
      )`);
    }
  } finally {
    legacy.close();
  }
}

function seedUnknownLegacyReviewTable(databasePath: string): void {
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`CREATE TABLE pr_reviews (
      feature_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      pull_title TEXT NOT NULL,
      pull_url TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      base_branch TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      core_analysis TEXT,
      changed_files INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generated_at TEXT,
      failure_message TEXT,
      failed_at TEXT,
      legacy_note TEXT
    )`);
  } finally {
    legacy.close();
  }
}

function seedConflictingReviewRows(databasePath: string): void {
  const db = openWorkspaceDatabase(databasePath);
  try {
    db.exec(`CREATE TABLE main.pr_reviews (
      feature_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      pull_title TEXT NOT NULL,
      pull_url TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      base_branch TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      core_analysis TEXT,
      changed_files INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generated_at TEXT,
      failure_message TEXT,
      failed_at TEXT
    )`);
    db.exec(`INSERT INTO main.pr_reviews (
      feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
      base_branch, status, summary, core_analysis, changed_files,
      created_at, updated_at, generated_at, failure_message, failed_at
    ) VALUES (
      'feat-1', 'repo-1', 7, 'Legacy title', 'https://example.test/legacy',
      'C:\\\\legacy', 'main', 'ready', 'Legacy summary', 'Legacy core', 3,
      'now', 'now', NULL, NULL, NULL
    )`);
    db.exec(`CREATE TABLE content.pr_reviews (
      feature_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      pull_number INTEGER NOT NULL,
      pull_title TEXT NOT NULL,
      pull_url TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      base_branch TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      core_analysis TEXT,
      changed_files INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      generated_at TEXT,
      failure_message TEXT,
      failed_at TEXT,
      document TEXT
    )`);
    db.exec(`INSERT INTO content.pr_reviews (
      feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
      base_branch, status, summary, core_analysis, changed_files,
      created_at, updated_at, generated_at, failure_message, failed_at, document
    ) VALUES (
      'feat-1', 'repo-1', 7, 'Different title', 'https://example.test/current',
      'C:\\\\current', 'release', 'failed', 'Different summary', 'Different core', 9,
      'now', 'now', 'later', 'boom', 'later', '{\"kind\":\"conflict\"}'
    )`);
  } finally {
    db.close();
  }
}

function seedLegacyAutomations(databasePath: string): void {
  const db = openWorkspaceDatabase(databasePath);
  try {
    db.exec(`CREATE TABLE automations.automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('short', 'long')),
      status TEXT NOT NULL CHECK (
        status IN ('active', 'paused', 'completed', 'failed', 'cancelled')
      ),
      origin_session_id TEXT,
      origin_feature_id TEXT,
      check_spec TEXT NOT NULL,
      condition_spec TEXT NOT NULL,
      action_spec TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      max_runs INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      progress TEXT,
      planned_steps TEXT NOT NULL DEFAULT '[]',
      last_occurrence_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT,
      next_run_at TEXT,
      failure TEXT
    )`);
    db.exec(`INSERT INTO automations.automations
      (id, name, mode, status, check_spec, condition_spec, action_spec,
       interval_ms, created_at, updated_at)
      VALUES ('a1', 'Mon', 'long', 'active', '{}', '{}', '{}', 60000,
              'now', 'now')`);
  } finally {
    db.close();
  }
}

function prepareUsageAfterDropFixture(
  databasePath: string,
  journalStatus: 'running' | 'failed',
): void {
  seedLegacyUsageEvents(databasePath);
  expect(() =>
    createDatabase(
      { databasePath },
      failAtStage(LEGACY_USAGE_MIGRATION, 'drop-source', 'after'),
    ),
  ).toThrow(/Injected after drop-source/);

  if (journalStatus === 'running') {
    setMigrationJournalState(databasePath, LEGACY_USAGE_MIGRATION, {
      status: 'running',
      activeStage: 'drop-source',
      lastError: null,
      stageStatus: 'running',
      stageDetail: 'Dropping main.usage_events',
    });
  }
}

function prepareAutomationsAfterDropFixture(
  databasePath: string,
  journalStatus: 'running' | 'failed',
): void {
  seedLegacyAutomations(databasePath);
  expect(() =>
    createDatabase(
      { databasePath },
      failAtStage(LEGACY_AUTOMATIONS_MIGRATION, 'drop-source', 'after'),
    ),
  ).toThrow(/Injected after drop-source/);

  if (journalStatus === 'running') {
    setMigrationJournalState(databasePath, LEGACY_AUTOMATIONS_MIGRATION, {
      status: 'running',
      activeStage: 'drop-source',
      lastError: null,
      stageStatus: 'running',
      stageDetail: 'Dropping automations.automations_legacy',
    });
  }
}

function expectUsageRowsMoved(db: DatabaseSync): void {
  expect(tableExists(db, 'main', 'usage_events')).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM usage.usage_events').get()).toEqual({
    n: 1,
  });
  expect(
    db.prepare(
      'SELECT feature_id, turn_index FROM usage.usage_events WHERE session_id = ?',
    ).get('s1'),
  ).toEqual({
    feature_id: 'f1',
    turn_index: 0,
  });
}

function expectAutomationsRebuilt(db: DatabaseSync): void {
  expect(tableExists(db, 'automations', 'automations_legacy')).toBe(false);
  expect(
    db
      .prepare("SELECT name FROM automations.automations WHERE id = 'a1'")
      .get(),
  ).toEqual({ name: 'Mon' });
  expect(() =>
    db.exec(
      "UPDATE automations.automations SET status = 'needs-auth' WHERE id = 'a1'",
    ),
  ).not.toThrow();
}

const relocationFailureCheckpoints = [
  ['before', 'backup'],
  ['after', 'backup'],
  ['before', 'copy'],
  ['after', 'copy'],
  ['before', 'verify'],
  ['after', 'verify'],
  ['before', 'drop-source'],
  ['after', 'drop-source'],
] as const;

const automationsFailureCheckpoints = [
  ['before', 'backup'],
  ['after', 'backup'],
  ['before', 'rename-legacy'],
  ['after', 'rename-legacy'],
  ['before', 'create-target'],
  ['after', 'create-target'],
  ['before', 'copy'],
  ['after', 'copy'],
  ['before', 'verify'],
  ['after', 'verify'],
  ['before', 'drop-source'],
  ['after', 'drop-source'],
] as const;

describe('db schema/connection', () => {
  it('creates app-owned meta operations in usage storage with honest unknown defaults', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      expect(tableExists(db, 'usage', 'meta_operations')).toBe(true);
      expect(tableExists(db, 'main', 'meta_operations')).toBe(false);
      expect(tableExists(db, 'usage', 'meta_operation_sessions')).toBe(true);
      expect(tableExists(db, 'main', 'meta_operation_sessions')).toBe(false);
      expect(db.prepare('PRAGMA usage.foreign_key_list(meta_operation_sessions)').all())
        .toMatchObject([{ table: 'meta_operations', from: 'operation_id', to: 'operation_id', on_delete: 'CASCADE' }]);
      expect(db.prepare('PRAGMA usage.foreign_key_list(meta_operations)').all()).toEqual([]);
      db.prepare(`INSERT INTO usage.meta_operations
        (operation_id, feature_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run('op-1', 'f1', 'created', 'updated');
      expect(db.prepare('SELECT * FROM usage.meta_operations WHERE operation_id = ?').get('op-1'))
        .toMatchObject({
          operation_id: 'op-1',
          state: 'pending',
          outcome: 'unknown',
          transport: 'unknown',
          usage_state: 'unknown',
          session_ids_json: '[]',
          origin_session_id: null,
          result_text: null,
          usage_json: null,
          finished_at: null,
        });
      expect(() => db.prepare('UPDATE usage.meta_operations SET state = ?').run('invented'))
        .toThrow(/CHECK constraint/);
      expect(() => db.prepare('UPDATE usage.meta_operations SET outcome = ?').run('succeeded'))
        .toThrow(/CHECK constraint/);
      expect(() => db.prepare('UPDATE usage.meta_operations SET usage_state = ?').run('zero'))
        .toThrow(/CHECK constraint/);
      expect(allIndexes(db)).toEqual(expect.arrayContaining([
        'idx_meta_operations_feature',
        'idx_meta_operations_automation',
        'idx_meta_operations_session',
        'idx_meta_operations_origin_session',
        'idx_meta_operations_state',
        'idx_meta_operation_sessions_operation',
      ]));
    } finally {
      db.close();
    }
  });

  it('adds operation storage without inventing legacy results and retains full output across reopen', () => {
    const dir = makeWorkspaceDir('meta-operation-upgrade');
    const databasePath = join(dir, 'workspace.db');
    const result = 'Full durable warm response.\n'.repeat(500);
    try {
      const previous = createDatabase({ databasePath });
      try {
        previous.exec('DROP TABLE usage.meta_operation_sessions');
        previous.exec('DROP TABLE usage.meta_operations');
        previous.prepare(`INSERT INTO usage.meta_usage_records
          (session_id, feature_id, provider_id, requested_model, transport, captured_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run('legacy', 'f1', 'provider', 'model', 'warm-acp', 'before');
      } finally {
        previous.close();
      }
      const upgraded = createDatabase({ databasePath });
      try {
        expect(upgraded.prepare('SELECT operation_id FROM usage.meta_operations').all()).toEqual([]);
        expect(upgraded.prepare('SELECT session_id FROM usage.meta_usage_records').all())
          .toMatchObject([{ session_id: 'legacy' }]);
        upgraded.prepare(`INSERT INTO usage.meta_operations
          (operation_id, feature_id, automation_id, origin_session_id, session_ids_json,
           state, outcome, result_text, created_at, updated_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('op', 'f1', 'monitor', 'origin', '["attempt-a","attempt-b"]',
            'completed', 'returned', result, 'created', 'finished', 'finished');
      } finally {
        upgraded.close();
      }
      const reopened = createDatabase({ databasePath });
      try {
        expect(reopened.prepare(`SELECT result_text, session_ids_json, origin_session_id,
          usage_state FROM usage.meta_operations WHERE operation_id = ?`).get('op'))
          .toMatchObject({
            result_text: result,
            session_ids_json: '["attempt-a","attempt-b"]',
            origin_session_id: 'origin',
            usage_state: 'unknown',
          });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfills observed application sessions once, atomically and without provider identities', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      db.exec('DROP TABLE usage.meta_operation_sessions');
      db.prepare(`INSERT INTO usage.meta_operations
        (operation_id, feature_id, origin_session_id, session_id, provider_session_id, session_ids_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('op', 'feature', 'origin', 'last', 'provider', '["first","last","first",null,7]', 't', 't');
      applySchema(db);
      const mappings = () => db.prepare('SELECT * FROM usage.meta_operation_sessions ORDER BY session_id').all();
      expect(mappings()).toEqual([
        { session_id: 'first', operation_id: 'op' },
        { session_id: 'last', operation_id: 'op' },
        { session_id: 'origin', operation_id: 'op' },
      ]);
      db.exec(`UPDATE usage.meta_operations SET session_ids_json = 'not valid json'`);
      applySchema(db);
      expect(mappings()).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('retains operation data and retries interrupted index initialization', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      db.exec('DROP TABLE usage.meta_operation_sessions');
      db.exec(`INSERT INTO usage.meta_operations
        (operation_id, feature_id, origin_session_id, session_ids_json, result_text, created_at, updated_at)
        VALUES ('op', 'feature', 'origin', 'invalid json', 'full result', 't', 't')`);
      expect(() => applySchema(db)).toThrow(/malformed JSON/);
      expect(tableExists(db, 'usage', 'meta_operation_sessions')).toBe(false);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare('SELECT result_text FROM usage.meta_operations').get())
        .toEqual({ result_text: 'full result' });
      db.exec(`UPDATE usage.meta_operations SET session_ids_json = '["attempt"]'`);
      applySchema(db);
      expect(db.prepare('SELECT session_id FROM usage.meta_operation_sessions ORDER BY session_id').all())
        .toEqual([{ session_id: 'attempt' }, { session_id: 'origin' }]);
    } finally {
      db.close();
    }
  });

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
    const dir = makeWorkspaceDir('split');
    try {
      const db = createDatabase({ databasePath: join(dir, 'workspace.db') });
      const mainTables = (
        db
          .prepare("SELECT name FROM main.sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(mainTables).toContain('features');
      expect(mainTables).toContain('repository_contexts');
      expect(mainTables).not.toContain('usage_events');
      expect(mainTables).not.toContain('feature_tasks');
      db.close();
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
        'idx_usage_events_session_started_at',
        'idx_usage_capture_rows_turn',
        'idx_skill_attachments_skill_id',
        'idx_skill_attachments_target',
        'idx_feature_tasks_feature_id',
        'idx_automation_runs_automation_id',
        'idx_automation_runs_open_automation_id',
        'idx_automation_runs_open_phase',
      ]),
    );
  });

  it('is idempotent when applied twice', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('renames the legacy capture replay index to the canonical turn index', () => {
    const dir = makeWorkspaceDir('usage-capture-turn-index');
    try {
      const databasePath = join(dir, 'workspace.db');
      const created = createDatabase({ databasePath });
      created.exec('DROP INDEX usage.idx_usage_capture_rows_turn');
      created.exec(
        'CREATE UNIQUE INDEX usage.idx_usage_capture_rows_session_turn ON usage_capture_rows (session_id, turn_index)',
      );
      created.close();

      const migrated = createDatabase({ databasePath });
      const indexes = allIndexes(migrated);
      migrated.close();

      expect(indexes).toContain('idx_usage_capture_rows_turn');
      expect(indexes).not.toContain('idx_usage_capture_rows_session_turn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relocates a legacy monolithic table into its sibling database', () => {
    const dir = makeWorkspaceDir('usage-relocate');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedLegacyUsageEvents(databasePath);

      const db = createDatabase({ databasePath });
      expectUsageRowsMoved(db);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['empty', false],
    ['populated', true],
  ])(
    'relocates a legacy document-less pr review table when %s',
    (_label, populated) => {
      const dir = makeWorkspaceDir('pr-review-relocate');
      try {
        const databasePath = join(dir, 'workspace.db');
        seedLegacyReviewTable(databasePath, populated);

        const db = createDatabase({ databasePath });
        expect(tableExists(db, 'main', 'pr_reviews')).toBe(false);
        expect(db.prepare('SELECT COUNT(*) AS n FROM content.pr_reviews').get()).toEqual({
          n: populated ? 1 : 0,
        });
        if (populated) {
          expect(
            db.prepare(
              `SELECT pull_title, changed_files, document
               FROM content.pr_reviews
               WHERE feature_id = 'feat-1'`,
            ).get(),
          ).toEqual({
            pull_title: 'Legacy title',
            changed_files: 7,
            document: null,
          });
        }
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('rejects an unknown legacy review shape without discarding the source table', () => {
    const dir = makeWorkspaceDir('unknown-review-shape');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedUnknownLegacyReviewTable(databasePath);

      expect(() => createDatabase({ databasePath })).toThrow(
        /Unsupported legacy schema for main\.pr_reviews/,
      );

      const db = openWorkspaceDatabase(databasePath);
      expect(tableExists(db, 'main', 'pr_reviews')).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with an actionable conflict instead of silently ignoring mismatched target rows', () => {
    const dir = makeWorkspaceDir('review-conflict');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedConflictingReviewRows(databasePath);

      expect(() => createDatabase({ databasePath })).toThrow(
        /conflicts with existing rows in content\.pr_reviews/,
      );

      const db = openWorkspaceDatabase(databasePath);
      expect(tableExists(db, 'main', 'pr_reviews')).toBe(true);
      expect(
        db.prepare(
          "SELECT pull_title FROM content.pr_reviews WHERE feature_id = 'feat-1'",
        ).get(),
      ).toEqual({ pull_title: 'Different title' });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores a failed migration backup across every touched database file', () => {
    const dir = makeWorkspaceDir('restore-backup');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedLegacyUsageEvents(databasePath);

      expect(() =>
        createDatabase(
          { databasePath },
          failAtStage(LEGACY_USAGE_MIGRATION, 'copy', 'after'),
        ),
      ).toThrow(/Injected after copy/);

      const backupPath = readBackupPath(databasePath, LEGACY_USAGE_MIGRATION);
      const damaged = openWorkspaceDatabase(databasePath);
      damaged.exec('DELETE FROM main.usage_events');
      damaged.exec('DELETE FROM usage.usage_events');
      damaged.close();

      restoreMigrationBackup(backupPath);

      const restored = openWorkspaceDatabase(databasePath);
      expect(tableExists(restored, 'main', 'usage_events')).toBe(true);
      expect(restored.prepare('SELECT COUNT(*) AS n FROM main.usage_events').get()).toEqual({
        n: 1,
      });
      expect(
        restored.prepare('SELECT COUNT(*) AS n FROM usage.usage_events').get(),
      ).toEqual({ n: 0 });
      restored.close();

      const migrated = createDatabase({ databasePath });
      expectUsageRowsMoved(migrated);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(relocationFailureCheckpoints)(
    'resumes legacy usage_events relocation after failure %s %s',
    (when, stage) => {
      const dir = makeWorkspaceDir(`usage-resume-${when}-${stage}`);
      try {
        const databasePath = join(dir, 'workspace.db');
        seedLegacyUsageEvents(databasePath);

        expect(() =>
          createDatabase({ databasePath }, failAtStage(LEGACY_USAGE_MIGRATION, stage, when)),
        ).toThrow(new RegExp(`Injected ${when} ${stage}`));

        const resumed = createDatabase({ databasePath });
        expectUsageRowsMoved(resumed);
        resumed.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['running', 'failed'] as const)(
    'completes interrupted usage_events relocation after drop-source when the journal is %s',
    (journalStatus) => {
      const dir = makeWorkspaceDir(`usage-after-drop-${journalStatus}`);
      try {
        const databasePath = join(dir, 'workspace.db');
        prepareUsageAfterDropFixture(databasePath, journalStatus);
        const backupPath = readBackupPath(databasePath, LEGACY_USAGE_MIGRATION);

        const resumed = createDatabase({ databasePath });
        expectUsageRowsMoved(resumed);
        resumed.close();

        expect(readMigrationRow(databasePath, LEGACY_USAGE_MIGRATION)).toEqual({
          status: 'completed',
          active_stage: null,
          backup_path: backupPath,
          last_error: null,
        });
        expect(readStageRow(databasePath, LEGACY_USAGE_MIGRATION, 'drop-source')).toEqual({
          status: 'completed',
          detail: expect.stringMatching(/Re-verified the replacement state/),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['running', 'failed'] as const)(
    'keeps the %s usage_events relocation journal failed when the dropped source cannot be re-verified',
    (journalStatus) => {
      const dir = makeWorkspaceDir(`usage-damaged-after-drop-${journalStatus}`);
      try {
        const databasePath = join(dir, 'workspace.db');
        prepareUsageAfterDropFixture(databasePath, journalStatus);
        const backupPath = readBackupPath(databasePath, LEGACY_USAGE_MIGRATION);

        const damaged = openWorkspaceDatabase(databasePath);
        damaged.exec('DELETE FROM usage.usage_events');
        damaged.close();

        expect(() => createDatabase({ databasePath })).toThrow(
          /restoreMigrationBackup\('.*relocate-usage-usage_events.*'\).*has 1 rows but usage\.usage_events has 0 rows/s,
        );
        expect(readMigrationRow(databasePath, LEGACY_USAGE_MIGRATION)).toEqual({
          status: 'failed',
          active_stage: 'drop-source',
          backup_path: backupPath,
          last_error: expect.stringMatching(/restoreMigrationBackup/),
        });
        expect(readStageRow(databasePath, LEGACY_USAGE_MIGRATION, 'drop-source')).toEqual({
          status: 'failed',
          detail: expect.stringMatching(/restoreMigrationBackup/),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('adds the sessions.name column to a legacy database', () => {
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
      exit_code INTEGER
    )`);
    expect(sessionColumns(db)).not.toContain('name');
    applySchema(db);
    expect(sessionColumns(db)).toContain('name');
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
    expect(db.prepare("SELECT order_index FROM features WHERE id = 'f1'").get()).toEqual({
      order_index: 0,
    });
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

  it('rebuilds a legacy automations table to allow the needs-auth status', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("ATTACH DATABASE ':memory:' AS automations");
    db.exec(`CREATE TABLE automations.automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('short', 'long')),
      status TEXT NOT NULL CHECK (
        status IN ('active', 'paused', 'completed', 'failed', 'cancelled')
      ),
      origin_session_id TEXT,
      origin_feature_id TEXT,
      check_spec TEXT NOT NULL,
      condition_spec TEXT NOT NULL,
      action_spec TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      max_runs INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      progress TEXT,
      planned_steps TEXT NOT NULL DEFAULT '[]',
      last_occurrence_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_checked_at TEXT,
      next_run_at TEXT,
      failure TEXT
    )`);
    db.exec(`INSERT INTO automations.automations
      (id, name, mode, status, check_spec, condition_spec, action_spec,
       interval_ms, created_at, updated_at)
      VALUES ('a1', 'Mon', 'long', 'active', '{}', '{}', '{}', 60000,
              'now', 'now')`);
    expect(() =>
      db.exec(
        "UPDATE automations.automations SET status = 'needs-auth' WHERE id = 'a1'",
      ),
    ).toThrow();

    applySchema(db);
    expectAutomationsRebuilt(db);
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it('adds durable occurrence columns to legacy automation runs', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("ATTACH DATABASE ':memory:' AS automations");
    db.exec(`CREATE TABLE automations.automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      triggered INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
      detail TEXT,
      session_id TEXT
    )`);
    db.exec(`INSERT INTO automations.automation_runs (
      id, automation_id, started_at, ended_at, triggered, status, detail, session_id
    ) VALUES (
      'r1', 'a1', '2026-01-01T00:00:00.000Z', NULL, 0, 'skipped', 'queued', NULL
    )`);

    applySchema(db);

    expect(automationRunColumns(db)).toEqual(
      expect.arrayContaining([
        'source',
        'phase',
        'scheduled_for_at',
        'occurrence_key',
        'dedupe_key',
        'dispatched_at',
        'acknowledged_run_ids',
        'acknowledged_snapshot_run_ids',
        'resolved_by_run_id',
      ]),
    );
    expect(
      db
        .prepare(
          `SELECT source, phase, scheduled_for_at, occurrence_key, dedupe_key, dispatched_at,
                  acknowledged_run_ids, acknowledged_snapshot_run_ids, resolved_by_run_id
           FROM automations.automation_runs WHERE id = 'r1'`,
        )
        .get(),
    ).toEqual({
      source: 'scheduled',
      phase: 'finished',
      scheduled_for_at: null,
      occurrence_key: null,
      dedupe_key: null,
      dispatched_at: null,
      acknowledged_run_ids: null,
      acknowledged_snapshot_run_ids: null,
      resolved_by_run_id: null,
    });
    db.close();
  });

  it('adds durable finality columns to legacy usage capture state', () => {
    const dir = makeWorkspaceDir('usage-capture-finality');
    try {
      const databasePath = join(dir, 'workspace.db');
      const db = openWorkspaceDatabase(databasePath);
      db.exec(`CREATE TABLE usage.usage_capture_state (
        session_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        cursor TEXT,
        replay_cursor INTEGER,
        status TEXT NOT NULL,
        reason TEXT
      )`);
      db.exec(`INSERT INTO usage.usage_capture_state
        (session_id, source_id, cursor, replay_cursor, status, reason)
        VALUES ('s1', 'source', '5', 3, 'retrying', 'waiting')`);

      applySchema(db);

      expect(usageCaptureStateColumns(db)).toEqual(expect.arrayContaining([
        'final_scan',
        'replay_clean',
        'source_done',
        'replay_done',
      ]));
      expect(
        db.prepare(`SELECT final_scan, replay_clean, source_done, replay_done
          FROM usage.usage_capture_state WHERE session_id = 's1'`).get(),
      ).toEqual({
        final_scan: 0,
        replay_clean: 0,
        source_done: 0,
        replay_done: 0,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relocates historical main automation runs and resumes an interrupted copy safely', () => {
    const dir = makeWorkspaceDir('legacy-main-automation-runs');
    try {
      const databasePath = join(dir, 'workspace.db');
      const seed = new DatabaseSync(databasePath);
      seed.exec(`CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        triggered INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
        detail TEXT,
        session_id TEXT
      )`);
      seed.exec(`INSERT INTO automation_runs (
        id, automation_id, started_at, ended_at, triggered, status, detail, session_id
      ) VALUES (
        'r1', 'a1', '2026-01-01T00:00:00.000Z', NULL, 0, 'skipped', 'queued', NULL
      )`);
      seed.close();

      expect(() =>
        createDatabase(
          { databasePath },
          failAtStage(LEGACY_AUTOMATION_RUNS_MIGRATION, 'copy', 'after'),
        ),
      ).toThrow(/Injected after copy/);

      const db = createDatabase({ databasePath });
      expect(tableExists(db, 'main', 'automation_runs')).toBe(false);
      expect(automationRunColumns(db)).toEqual(
        expect.arrayContaining([
          'source',
          'phase',
          'scheduled_for_at',
          'occurrence_key',
          'dedupe_key',
          'dispatched_at',
          'report',
          'acknowledged_run_ids',
          'acknowledged_snapshot_run_ids',
          'resolved_by_run_id',
        ]),
      );
      expect(
        db
          .prepare(
            `SELECT source, phase, scheduled_for_at, occurrence_key, dedupe_key, dispatched_at,
                    report, acknowledged_run_ids, acknowledged_snapshot_run_ids, resolved_by_run_id
             FROM automations.automation_runs WHERE id = 'r1'`,
          )
          .get(),
      ).toEqual({
        source: 'scheduled',
        phase: 'finished',
        scheduled_for_at: null,
        occurrence_key: null,
        dedupe_key: null,
        dispatched_at: '2026-01-01T00:00:00.000Z',
        report: null,
        acknowledged_run_ids: null,
        acknowledged_snapshot_run_ids: null,
        resolved_by_run_id: null,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(automationsFailureCheckpoints)(
    'resumes legacy automations rebuild after failure %s %s',
    (when, stage) => {
      const dir = makeWorkspaceDir(`automations-resume-${when}-${stage}`);
      try {
        const databasePath = join(dir, 'workspace.db');
        seedLegacyAutomations(databasePath);

        expect(() =>
          createDatabase(
            { databasePath },
            failAtStage(LEGACY_AUTOMATIONS_MIGRATION, stage, when),
          ),
        ).toThrow(new RegExp(`Injected ${when} ${stage}`));

        const resumed = createDatabase({ databasePath });
        expectAutomationsRebuilt(resumed);
        resumed.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['running', 'failed'] as const)(
    'completes interrupted automations rebuild after drop-source when the journal is %s',
    (journalStatus) => {
      const dir = makeWorkspaceDir(`automations-after-drop-${journalStatus}`);
      try {
        const databasePath = join(dir, 'workspace.db');
        prepareAutomationsAfterDropFixture(databasePath, journalStatus);
        const backupPath = readBackupPath(databasePath, LEGACY_AUTOMATIONS_MIGRATION);

        const resumed = createDatabase({ databasePath });
        expectAutomationsRebuilt(resumed);
        resumed.close();

        expect(readMigrationRow(databasePath, LEGACY_AUTOMATIONS_MIGRATION)).toEqual({
          status: 'completed',
          active_stage: null,
          backup_path: backupPath,
          last_error: null,
        });
        expect(
          readStageRow(databasePath, LEGACY_AUTOMATIONS_MIGRATION, 'drop-source'),
        ).toEqual({
          status: 'completed',
          detail: expect.stringMatching(/Re-verified the replacement state/),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['running', 'failed'] as const)(
    'keeps the %s automations rebuild journal failed when the rebuilt table is missing after drop-source',
    (journalStatus) => {
      const dir = makeWorkspaceDir(`automations-missing-after-drop-${journalStatus}`);
      try {
        const databasePath = join(dir, 'workspace.db');
        prepareAutomationsAfterDropFixture(databasePath, journalStatus);
        const backupPath = readBackupPath(databasePath, LEGACY_AUTOMATIONS_MIGRATION);

        const damaged = openWorkspaceDatabase(databasePath);
        damaged.exec('DROP TABLE automations.automations');
        damaged.close();

        expect(() => createDatabase({ databasePath })).toThrow(
          /restoreMigrationBackup\('.*rebuild-automations-needs-auth-status.*'\).*has 1 rows but automations\.automations has 0 rows/s,
        );
        expect(readMigrationRow(databasePath, LEGACY_AUTOMATIONS_MIGRATION)).toEqual({
          status: 'failed',
          active_stage: 'drop-source',
          backup_path: backupPath,
          last_error: expect.stringMatching(/restoreMigrationBackup/),
        });
        expect(
          readStageRow(databasePath, LEGACY_AUTOMATIONS_MIGRATION, 'drop-source'),
        ).toEqual({
          status: 'failed',
          detail: expect.stringMatching(/restoreMigrationBackup/),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('records migration journal state and keeps the backup path after a failed run', () => {
    const dir = makeWorkspaceDir('journal-state');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedLegacyUsageEvents(databasePath);

      expect(() =>
        createDatabase(
          { databasePath },
          failAtStage(LEGACY_USAGE_MIGRATION, 'verify', 'before'),
        ),
      ).toThrow(/Injected before verify/);

      const db = new DatabaseSync(databasePath);
      expect(
        db
          .prepare(
            `SELECT status, active_stage, backup_path, last_error
             FROM schema_migrations
             WHERE migration_id = ?`,
          )
          .get(LEGACY_USAGE_MIGRATION),
      ).toEqual({
        status: 'failed',
        active_stage: 'verify',
        backup_path: readBackupPath(databasePath, LEGACY_USAGE_MIGRATION),
        last_error: expect.stringMatching(/Injected before verify/),
      });
      expect(
        db
          .prepare(
            `SELECT status FROM schema_migration_stages
             WHERE migration_id = ? AND stage = 'verify'`,
          )
          .get(LEGACY_USAGE_MIGRATION),
      ).toEqual({ status: 'failed' });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the connection when schema application fails during createDatabase', () => {
    const dir = makeWorkspaceDir('close-on-failure');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedLegacyUsageEvents(databasePath);

      expect(() =>
        createDatabase(
          { databasePath },
          failAtStage(LEGACY_USAGE_MIGRATION, 'backup', 'before'),
        ),
      ).toThrow(/Injected before backup/);

      expect(() =>
        createDatabase({ databasePath }, failAtStage(LEGACY_USAGE_MIGRATION, 'copy', 'before')),
      ).toThrow(/Injected before copy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records non-Error stage hook failures verbatim in migration errors', () => {
    const dir = makeWorkspaceDir('non-error-stage-failure');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedLegacyUsageEvents(databasePath);

      expect(() =>
        createDatabase({
          databasePath,
        }, {
          stageHooks: {
            beforeStage(info) {
              if (info.migrationId === LEGACY_USAGE_MIGRATION && info.stage === 'backup') {
                throw 'string failure';
              }
            },
          },
        }),
      ).toThrow(/Cause: string failure/);

      expect(readMigrationRow(databasePath, LEGACY_USAGE_MIGRATION)).toEqual({
        status: 'failed',
        active_stage: 'backup',
        backup_path: null,
        last_error: expect.stringMatching(/Cause: string failure/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes migration backups into a stable per-migration directory', () => {
    const dir = makeWorkspaceDir('backup-reuse');
    try {
      const databasePath = join(dir, 'workspace.db');
      seedLegacyUsageEvents(databasePath);

      expect(() =>
        createDatabase(
          { databasePath },
          failAtStage(LEGACY_USAGE_MIGRATION, 'backup', 'after'),
        ),
      ).toThrow(/Injected after backup/);

      const firstBackupPath = readBackupPath(databasePath, LEGACY_USAGE_MIGRATION);
      expect(existsSync(join(firstBackupPath, 'manifest.json'))).toBe(true);

      expect(() =>
        createDatabase(
          { databasePath },
          failAtStage(LEGACY_USAGE_MIGRATION, 'copy', 'before'),
        ),
      ).toThrow(/Injected before copy/);

      expect(readBackupPath(databasePath, LEGACY_USAGE_MIGRATION)).toBe(firstBackupPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with restore guidance when a recorded migration backup cannot be read during recovery', () => {
    const dir = makeWorkspaceDir('backup-missing-during-recovery');
    try {
      const databasePath = join(dir, 'workspace.db');
      prepareUsageAfterDropFixture(databasePath, 'failed');
      const backupPath = readBackupPath(databasePath, LEGACY_USAGE_MIGRATION);

      rmSync(backupPath, { recursive: true, force: true });

      expect(() => createDatabase({ databasePath })).toThrow(
        /restoreMigrationBackup\('.*relocate-usage-usage_events.*'\).*manifest\.json/s,
      );
      expect(readMigrationRow(databasePath, LEGACY_USAGE_MIGRATION)).toEqual({
        status: 'failed',
        active_stage: 'drop-source',
        backup_path: backupPath,
        last_error: expect.stringMatching(/manifest\.json/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with an actionable error when an interrupted migration has no recorded backup path', () => {
    const dir = makeWorkspaceDir('missing-recovery-backup-path');
    try {
      const databasePath = join(dir, 'workspace.db');
      const created = createDatabase({ databasePath });
      created.close();

      const db = new DatabaseSync(databasePath);
      db.prepare(
        `INSERT INTO schema_migrations
         (migration_id, description, status, active_stage, backup_path, last_error, updated_at)
         VALUES (?, ?, 'running', NULL, NULL, NULL, CURRENT_TIMESTAMP)`,
      ).run(
        LEGACY_USAGE_MIGRATION,
        'Relocate legacy main.usage_events into usage.usage_events',
      );
      db.close();

      expect(() => createDatabase({ databasePath })).toThrow(
        /No recorded backup is available\..*Missing recorded backup path/s,
      );
      expect(readMigrationRow(databasePath, LEGACY_USAGE_MIGRATION)).toEqual({
        status: 'failed',
        active_stage: null,
        backup_path: null,
        last_error: expect.stringMatching(/Missing recorded backup path/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with restore guidance when recovery backup metadata omits the required schema snapshot', () => {
    const dir = makeWorkspaceDir('backup-missing-schema-entry');
    try {
      const databasePath = join(dir, 'workspace.db');
      prepareUsageAfterDropFixture(databasePath, 'failed');
      const backupPath = readBackupPath(databasePath, LEGACY_USAGE_MIGRATION);
      const manifestPath = join(backupPath, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        migrationId: string;
        entries: Array<{ schema: string; livePath: string; backupFile: string }>;
      };
      manifest.entries = manifest.entries.filter((entry) => entry.schema !== 'main');
      writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

      expect(() => createDatabase({ databasePath })).toThrow(
        /restoreMigrationBackup\('.*relocate-usage-usage_events.*'\).*does not include schema main/s,
      );
      expect(readMigrationRow(databasePath, LEGACY_USAGE_MIGRATION)).toEqual({
        status: 'failed',
        active_stage: 'drop-source',
        backup_path: backupPath,
        last_error: expect.stringMatching(/does not include schema main/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with restore guidance when recovery backup files are missing', () => {
    const dir = makeWorkspaceDir('backup-missing-snapshot-file');
    try {
      const databasePath = join(dir, 'workspace.db');
      prepareUsageAfterDropFixture(databasePath, 'failed');
      const backupPath = readBackupPath(databasePath, LEGACY_USAGE_MIGRATION);
      const manifest = JSON.parse(readFileSync(join(backupPath, 'manifest.json'), 'utf8')) as {
        entries: Array<{ schema: string; backupFile: string }>;
      };
      const mainSnapshot = manifest.entries.find((entry) => entry.schema === 'main');
      expect(mainSnapshot).toBeDefined();
      rmSync(join(backupPath, mainSnapshot!.backupFile), { force: true });

      expect(() => createDatabase({ databasePath })).toThrow(
        /restoreMigrationBackup\('.*relocate-usage-usage_events.*'\).*Backup file missing:/s,
      );
      expect(readMigrationRow(databasePath, LEGACY_USAGE_MIGRATION)).toEqual({
        status: 'failed',
        active_stage: 'drop-source',
        backup_path: backupPath,
        last_error: expect.stringMatching(/Backup file missing:/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a managed migration needs to back up an in-memory attached schema', () => {
    const dir = makeWorkspaceDir('backup-in-memory-attached');
    const databasePath = join(dir, 'workspace.db');
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("ATTACH DATABASE ':memory:' AS usage");
      db.exec(`CREATE TABLE main.usage_events (
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
      db.exec(`INSERT INTO main.usage_events VALUES (
        's1','f1',0,'dev','copilot','auto','auto','chat',1,2,0,0.5,1.0,10,NULL,'now','now'
      )`);

      expect(() => applySchema(db)).toThrow(/Cannot back up in-memory schema usage/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails to restore a backup when the manifest is missing', () => {
    const dir = makeWorkspaceDir('restore-missing-manifest');
    try {
      expect(() => restoreMigrationBackup(join(dir, 'missing-backup'))).toThrow(
        /manifest\.json/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails to restore a backup when the manifest references a missing snapshot file', () => {
    const dir = makeWorkspaceDir('restore-missing-snapshot');
    try {
      const backupPath = join(dir, 'migration-backups', 'broken');
      mkdirSync(backupPath, { recursive: true });
      const livePath = join(dir, 'workspace.db');
      new DatabaseSync(livePath).close();
      const manifest = {
        migrationId: LEGACY_USAGE_MIGRATION,
        entries: [
          {
            schema: 'main',
            livePath,
            backupFile: 'workspace.db',
          },
        ],
      };
      writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify(manifest), 'utf8');

      expect(() => restoreMigrationBackup(backupPath)).toThrow(/workspace\.db/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps current tables untouched when no destructive migration is pending', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    expect(() => applySchema(db)).not.toThrow();
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE status = ?')
        .get('completed'),
    ).toEqual({ n: 0 });
    db.close();
  });
});
