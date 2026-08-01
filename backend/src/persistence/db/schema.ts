import type { DatabaseSync } from 'node:sqlite';

/** DDL for the workspace schema. Idempotent so it doubles as migration. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
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
  )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
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
  )`,
  `CREATE TABLE IF NOT EXISTS transcripts (
    session_id TEXT PRIMARY KEY,
    stdout TEXT NOT NULL,
    stderr TEXT NOT NULL,
    exit_code INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS summaries (
    feature_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    instructions TEXT NOT NULL,
    removal_instructions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS skill_attachments (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feature_tasks (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_files (
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    tool TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (session_id, path)
  )`,
  `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    name TEXT NOT NULL,
    local_path TEXT NOT NULL,
    default_branch TEXT,
    created_at TEXT NOT NULL
  )`,
];

/**
 * Indexes backing the hot lookups. Filters on foreign-key-like columns
 * (sessions by feature, attachments by skill/target, tasks by feature) would
 * otherwise force full table scans as the workspace grows. Applied after
 * {@link ADDED_COLUMNS} so indexes on retrofitted columns (e.g. features.repo_id)
 * are created only once the column exists.
 */
export const INDEX_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_feature_id
    ON sessions (feature_id)`,
  `CREATE INDEX IF NOT EXISTS idx_features_repo_id
    ON features (repo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_feature_id
    ON usage_events (feature_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_attachments_skill_id
    ON skill_attachments (skill_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_attachments_target
    ON skill_attachments (scope, target_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feature_tasks_feature_id
    ON feature_tasks (feature_id)`,
];

/**
 * Columns added after a table's initial release. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so these are applied idempotently for
 * databases created before the column existed.
 */
const ADDED_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'sessions', column: 'name', ddl: 'ALTER TABLE sessions ADD COLUMN name TEXT' },
  {
    table: 'skills',
    column: 'removal_instructions',
    ddl: "ALTER TABLE skills ADD COLUMN removal_instructions TEXT NOT NULL DEFAULT ''",
  },
  {
    table: 'features',
    column: 'repo_id',
    ddl: 'ALTER TABLE features ADD COLUMN repo_id TEXT',
  },
];

/** Adds a column to an existing table when it is missing. */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(ddl);
  }
}

/** Applies the schema to a database connection. */
export function applySchema(db: DatabaseSync): void {
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    addColumnIfMissing(db, table, column, ddl);
  }
  for (const statement of INDEX_STATEMENTS) {
    db.exec(statement);
  }
}
