import type { DatabaseSync } from 'node:sqlite';

/** A single table's name and idempotent `CREATE TABLE IF NOT EXISTS` DDL. */
export interface TableSchema {
  readonly name: string;
  readonly ddl: string;
}

/**
 * A logically-grouped database file. The workspace is split across several
 * SQLite files instead of one monolithic database so high-volume, append-heavy
 * data (usage analytics, transcripts, task plans) lives apart from the small
 * core catalog. Files are stitched back together with `ATTACH DATABASE`, so
 * every group is reachable through one connection and cross-group queries keep
 * working as long as table names stay globally unique.
 */
export interface DatabaseGroup {
  /** Attach alias / SQLite schema name. `main` is the primary file. */
  readonly schema: string;
  /** Sibling filename for non-primary groups; `null` for the primary file. */
  readonly file: string | null;
  readonly tables: readonly TableSchema[];
}

const CORE_TABLES: readonly TableSchema[] = [
  {
    name: 'features',
    ddl: `CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT
  )`,
  },
  {
    name: 'sessions',
    ddl: `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    resolved_model TEXT,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'feature',
    prompt TEXT NOT NULL,
    usage_file_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    exit_code INTEGER,
    name TEXT
  )`,
  },
  {
    name: 'feature_groups',
    ddl: `CREATE TABLE IF NOT EXISTS feature_groups (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    parent_group_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('subcategory', 'pr')),
    name TEXT NOT NULL,
    pr_number INTEGER,
    pr_url TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  },
  {
    name: 'repositories',
    ddl: `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    name TEXT NOT NULL,
    local_path TEXT NOT NULL,
    default_branch TEXT,
    created_at TEXT NOT NULL
  )`,
  },
  {
    // Kept in the same file as `repositories` so the ON DELETE CASCADE foreign
    // key is enforced (SQLite cannot enforce FKs across attached databases).
    name: 'repository_contexts',
    ddl: `CREATE TABLE IF NOT EXISTS repository_contexts (
    repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'generating', 'ready', 'stale', 'failed')
    ),
    content TEXT,
    source_revision TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    generation_started_at TEXT,
    generated_at TEXT,
    failure_code TEXT,
    failure_message TEXT,
    failed_at TEXT,
    failure_retryable INTEGER CHECK (
      failure_retryable IS NULL OR failure_retryable IN (0, 1)
    ),
    failure_step TEXT,
    steps TEXT NOT NULL DEFAULT '[]'
  )`,
  },
  {
    name: 'skills',
    ddl: `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    instructions TEXT NOT NULL,
    removal_instructions TEXT NOT NULL DEFAULT '',
    recommended_scope TEXT NOT NULL DEFAULT 'any',
    created_at TEXT NOT NULL
  )`,
  },
  {
    name: 'skill_attachments',
    ddl: `CREATE TABLE IF NOT EXISTS skill_attachments (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  },
  {
    // Central, layered shared-context documents (workspace/repo/feature). A
    // single curated markdown blob per scope, mirroring `repository_contexts`.
    // Kept in the core catalog since it is small and read on every launch.
    name: 'context_documents',
    ddl: `CREATE TABLE IF NOT EXISTS context_documents (
    scope TEXT NOT NULL CHECK (scope IN ('workspace', 'repo', 'feature')),
    scope_id TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL CHECK (updated_by IN ('merge', 'manual', 'import')),
    PRIMARY KEY (scope, scope_id)
  )`,
  },
  {
    // Persisted, user-editable configuration overrides keyed by namespace. Each
    // row stores a partial JSON patch that is deep-merged over the module's
    // compiled defaults at startup, so the Settings UI can reconfigure any
    // module without touching code or environment variables.
    name: 'config_overrides',
    ddl: `CREATE TABLE IF NOT EXISTS config_overrides (
    namespace TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  },
];

const USAGE_TABLES: readonly TableSchema[] = [
  {
    name: 'usage_events',
    ddl: `CREATE TABLE IF NOT EXISTS usage_events (
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
  },
];

const CONTENT_TABLES: readonly TableSchema[] = [
  {
    name: 'transcripts',
    ddl: `CREATE TABLE IF NOT EXISTS transcripts (
    session_id TEXT PRIMARY KEY,
    stdout TEXT NOT NULL,
    stderr TEXT NOT NULL,
    exit_code INTEGER
  )`,
  },
  {
    name: 'summaries',
    ddl: `CREATE TABLE IF NOT EXISTS summaries (
    feature_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  },
  {
    name: 'session_summaries',
    ddl: `CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  },
  {
    name: 'session_files',
    ddl: `CREATE TABLE IF NOT EXISTS session_files (
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    tool TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (session_id, path)
  )`,
  },
  {
    name: 'pr_reviews',
    ddl: `CREATE TABLE IF NOT EXISTS pr_reviews (
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
  )`,
  },
];

const TASK_TABLES: readonly TableSchema[] = [
  {
    name: 'feature_tasks',
    ddl: `CREATE TABLE IF NOT EXISTS feature_tasks (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  },
];

/**
 * The logical database layout. The primary file (`main`) holds the small core
 * catalog and the FK-linked repository pair; append-heavy data is partitioned
 * into sibling files to keep each database light and independently manageable.
 */
export const DATABASE_GROUPS: readonly DatabaseGroup[] = [
  { schema: 'main', file: null, tables: CORE_TABLES },
  { schema: 'usage', file: 'usage.db', tables: USAGE_TABLES },
  { schema: 'content', file: 'content.db', tables: CONTENT_TABLES },
  { schema: 'tasks', file: 'tasks.db', tables: TASK_TABLES },
];

/**
 * Flat DDL for every table, retained for callers/tests that want the raw
 * `CREATE TABLE` statements independent of the multi-file layout.
 */
export const SCHEMA_STATEMENTS: readonly string[] = DATABASE_GROUPS.flatMap(
  (group) => group.tables.map((table) => table.ddl),
);

/** An index and the schema (attached database) that owns its table. */
interface IndexSchema {
  readonly schema: string;
  readonly ddl: string;
}

/**
 * Indexes backing the hot lookups. Filters on foreign-key-like columns
 * (sessions by feature, attachments by skill/target, tasks by feature) would
 * otherwise force full table scans as the workspace grows. Each index is
 * created in the same attached database as its table. Applied after
 * {@link ADDED_COLUMNS} so indexes on retrofitted columns (e.g. features.repo_id)
 * are created only once the column exists.
 */
const INDEXES: readonly IndexSchema[] = [
  {
    schema: 'main',
    ddl: 'CREATE INDEX IF NOT EXISTS main.idx_sessions_feature_id ON sessions (feature_id)',
  },
  {
    schema: 'main',
    ddl: 'CREATE INDEX IF NOT EXISTS main.idx_feature_groups_feature_id ON feature_groups (feature_id)',
  },
  {
    schema: 'main',
    ddl: 'CREATE INDEX IF NOT EXISTS main.idx_features_repo_id ON features (repo_id)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_usage_events_feature_id ON usage_events (feature_id)',
  },
  {
    schema: 'main',
    ddl: 'CREATE INDEX IF NOT EXISTS main.idx_skill_attachments_skill_id ON skill_attachments (skill_id)',
  },
  {
    schema: 'main',
    ddl: 'CREATE INDEX IF NOT EXISTS main.idx_skill_attachments_target ON skill_attachments (scope, target_id)',
  },
  {
    schema: 'tasks',
    ddl: 'CREATE INDEX IF NOT EXISTS tasks.idx_feature_tasks_feature_id ON feature_tasks (feature_id)',
  },
];

/** Flat index DDL, retained for callers/tests that want the raw statements. */
export const INDEX_STATEMENTS: readonly string[] = INDEXES.map((index) => index.ddl);

/**
 * Columns added after a table's initial release. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so these are applied idempotently for
 * databases created before the column existed. Every retrofitted table lives in
 * the `main` file, so plain (unqualified) ALTER statements target it directly.
 */
const ADDED_COLUMNS: readonly {
  table: string;
  column: string;
  ddl: string;
  schema?: string;
}[] = [
  { table: 'sessions', column: 'name', ddl: 'ALTER TABLE sessions ADD COLUMN name TEXT' },
  {
    table: 'sessions',
    column: 'group_id',
    ddl: 'ALTER TABLE sessions ADD COLUMN group_id TEXT',
  },
  {
    table: 'sessions',
    column: 'order_index',
    ddl: 'ALTER TABLE sessions ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'sessions',
    column: 'scope',
    ddl: "ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'feature'",
  },
  {
    table: 'skills',
    column: 'removal_instructions',
    ddl: "ALTER TABLE skills ADD COLUMN removal_instructions TEXT NOT NULL DEFAULT ''",
  },
  {
    table: 'skills',
    column: 'recommended_scope',
    ddl: "ALTER TABLE skills ADD COLUMN recommended_scope TEXT NOT NULL DEFAULT 'any'",
  },
  {
    table: 'features',
    column: 'repo_id',
    ddl: 'ALTER TABLE features ADD COLUMN repo_id TEXT',
  },
  {
    table: 'features',
    column: 'checkout_path',
    ddl: 'ALTER TABLE features ADD COLUMN checkout_path TEXT',
  },
  {
    table: 'features',
    column: 'order_index',
    ddl: 'ALTER TABLE features ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'repository_contexts',
    column: 'failure_step',
    ddl: 'ALTER TABLE repository_contexts ADD COLUMN failure_step TEXT',
  },
  {
    table: 'repository_contexts',
    column: 'steps',
    ddl: "ALTER TABLE repository_contexts ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'",
  },
  {
    // pr_reviews lives in the content database; qualify the migration so the
    // structured per-step review document is added to the right attached file.
    table: 'pr_reviews',
    column: 'document',
    schema: 'content',
    ddl: 'ALTER TABLE content.pr_reviews ADD COLUMN document TEXT',
  },
];

/** Names of the databases currently attached to the connection. */
function attachedSchemas(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Whether a table exists in a specific attached database. */
function tableExistsIn(db: DatabaseSync, schema: string, table: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table);
  return row !== undefined;
}

/**
 * Ensures every non-primary group is reachable. `connection.ts` attaches the
 * sibling files before calling this; when {@link applySchema} is used directly
 * (e.g. legacy-migration tests) the groups are attached as scratch in-memory
 * databases so table creation still has a home.
 */
function ensureGroupsAttached(db: DatabaseSync): void {
  const attached = attachedSchemas(db);
  for (const group of DATABASE_GROUPS) {
    if (group.schema === 'main' || attached.has(group.schema)) {
      continue;
    }
    db.prepare(`ATTACH DATABASE ':memory:' AS ${group.schema}`).run();
  }
}

/** Rewrites `IF NOT EXISTS <name>` to target a specific attached database. */
function qualifyTable(schema: string, table: TableSchema): string {
  return table.ddl.replace(
    `IF NOT EXISTS ${table.name}`,
    `IF NOT EXISTS ${schema}.${table.name}`,
  );
}

/**
 * Moves a table that predates the split out of the primary file into its
 * target database, then drops the primary copy. This runs once when an older
 * monolithic `workspace.db` is opened; fresh databases have nothing to move.
 */
function relocateFromMain(db: DatabaseSync, schema: string, table: string): void {
  if (!tableExistsIn(db, 'main', table)) {
    return;
  }
  db.exec(`INSERT INTO ${schema}.${table} SELECT * FROM main.${table}`);
  db.exec(`DROP TABLE main.${table}`);
}

/** Adds a column to an existing table when it is missing. */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
  schema?: string,
): void {
  const info = schema ? `${schema}.table_info(${table})` : `table_info(${table})`;
  const columns = db.prepare(`PRAGMA ${info}`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(ddl);
  }
}

/** Applies the schema across the primary and attached databases. */
export function applySchema(db: DatabaseSync): void {
  ensureGroupsAttached(db);
  for (const group of DATABASE_GROUPS) {
    for (const table of group.tables) {
      if (group.schema === 'main') {
        db.exec(table.ddl);
      } else {
        db.exec(qualifyTable(group.schema, table));
        relocateFromMain(db, group.schema, table.name);
      }
    }
  }
  for (const { table, column, ddl, schema } of ADDED_COLUMNS) {
    addColumnIfMissing(db, table, column, ddl, schema);
  }
  for (const index of INDEXES) {
    db.exec(index.ddl);
  }
}
