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
];

/**
 * Columns added after a table's initial release. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so these are applied idempotently for
 * databases created before the column existed.
 */
const ADDED_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'sessions', column: 'name', ddl: 'ALTER TABLE sessions ADD COLUMN name TEXT' },
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
}
