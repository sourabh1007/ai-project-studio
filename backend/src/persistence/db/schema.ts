import type { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** A single table's name and idempotent `CREATE TABLE IF NOT EXISTS` DDL. */
export interface TableSchema {
  readonly name: string;
  readonly ddl: string;
  /** Runs only for a new table, atomically with creation so interrupted backfills retry. */
  readonly initialize?: string;
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

const LEGACY_USAGE_CAPTURE_ROWS_TURN_INDEX = 'idx_usage_capture_rows_session_turn';
const USAGE_CAPTURE_ROWS_TURN_INDEX = 'idx_usage_capture_rows_turn';

const USAGE_EVENTS_COLUMNS = [
  'session_id',
  'feature_id',
  'turn_index',
  'kind',
  'provider',
  'requested_model',
  'resolved_model',
  'operation',
  'input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'cost',
  'credits',
  'nano_aiu',
  'service_request_id',
  'started_at',
  'ended_at',
] as const;

const TRANSCRIPTS_COLUMNS = ['session_id', 'stdout', 'stderr', 'exit_code'] as const;
const SUMMARIES_COLUMNS = ['feature_id', 'content', 'created_at'] as const;
const SESSION_SUMMARIES_COLUMNS = ['session_id', 'content', 'created_at'] as const;
const SESSION_FILES_COLUMNS = ['session_id', 'path', 'tool', 'first_seen_at'] as const;

const PR_REVIEW_COLUMNS = [
  'feature_id',
  'repo_id',
  'pull_number',
  'pull_title',
  'pull_url',
  'worktree_path',
  'base_branch',
  'status',
  'summary',
  'core_analysis',
  'changed_files',
  'created_at',
  'updated_at',
  'generated_at',
  'failure_message',
  'failed_at',
  'document',
] as const;

const LEGACY_PR_REVIEW_COLUMNS = [
  'feature_id',
  'repo_id',
  'pull_number',
  'pull_title',
  'pull_url',
  'worktree_path',
  'base_branch',
  'status',
  'summary',
  'core_analysis',
  'changed_files',
  'created_at',
  'updated_at',
  'generated_at',
  'failure_message',
  'failed_at',
] as const;

const FEATURE_TASK_COLUMNS = [
  'id',
  'feature_id',
  'title',
  'detail',
  'status',
  'position',
  'created_at',
] as const;

const AUTOMATIONS_COLUMNS = [
  'id',
  'name',
  'mode',
  'status',
  'origin_session_id',
  'origin_feature_id',
  'check_spec',
  'condition_spec',
  'action_spec',
  'interval_ms',
  'max_runs',
  'run_count',
  'progress',
  'planned_steps',
  'last_occurrence_key',
  'created_at',
  'updated_at',
  'last_checked_at',
  'next_run_at',
  'failure',
] as const;

const AUTOMATION_RUN_COLUMNS = [
  'id',
  'automation_id',
  'source',
  'phase',
  'scheduled_for_at',
  'occurrence_key',
  'dedupe_key',
  'started_at',
  'dispatched_at',
  'ended_at',
  'triggered',
  'status',
  'detail',
  'session_id',
  'report',
  'acknowledged_run_ids',
  'acknowledged_snapshot_run_ids',
  'resolved_by_run_id',
] as const;

const SUBAGENT_COLUMNS = [
  'id',
  'automation_id',
  'origin_session_id',
  'origin_feature_id',
  'task',
  'status',
  'progress',
  'result',
  'session_id',
  'created_at',
  'updated_at',
] as const;

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
  {
    name: 'meta_usage_records',
    ddl: `CREATE TABLE IF NOT EXISTS meta_usage_records (
    session_id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    resolved_model TEXT,
    transport TEXT NOT NULL CHECK (transport IN ('warm-acp')),
    provider_session_id TEXT,
    purpose TEXT,
    label TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    nano_aiu INTEGER,
    credits REAL,
    captured_at TEXT NOT NULL
  )`,
  },
  {
    name: 'meta_operations',
    ddl: `CREATE TABLE IF NOT EXISTS meta_operations (
    operation_id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    automation_id TEXT,
    origin_session_id TEXT,
    provider_id TEXT,
    requested_model TEXT,
    resolved_model TEXT,
    session_id TEXT,
    provider_session_id TEXT,
    session_ids_json TEXT NOT NULL DEFAULT '[]',
    transport TEXT NOT NULL DEFAULT 'unknown' CHECK (
      transport IN ('unknown', 'session', 'warm-acp')
    ),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (
      state IN ('pending', 'running', 'interrupted', 'failed', 'completed')
    ),
    outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (
      outcome IN ('not-dispatched', 'unknown', 'returned')
    ),
    purpose TEXT,
    label TEXT,
    result_text TEXT,
    error_message TEXT,
    usage_state TEXT NOT NULL DEFAULT 'unknown' CHECK (
      usage_state IN ('unknown', 'unsupported', 'partial', 'recorded')
    ),
    usage_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,
  },
  {
    name: 'meta_operation_sessions',
    ddl: `CREATE TABLE IF NOT EXISTS meta_operation_sessions (
    session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES meta_operations(operation_id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, operation_id)
  )`,
    initialize: `INSERT INTO usage.meta_operation_sessions (session_id, operation_id)
      SELECT origin_session_id, operation_id FROM usage.meta_operations WHERE origin_session_id IS NOT NULL
      UNION SELECT session_id, operation_id FROM usage.meta_operations WHERE session_id IS NOT NULL
      UNION SELECT identity.value, operation.operation_id
        FROM usage.meta_operations AS operation, json_each(operation.session_ids_json) AS identity
        WHERE identity.type = 'text'`,
  },
  {
    name: 'usage_capture_state',
    ddl: `CREATE TABLE IF NOT EXISTS usage_capture_state (
    session_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    cursor TEXT,
    replay_cursor INTEGER,
    final_scan INTEGER NOT NULL DEFAULT 0,
    replay_clean INTEGER NOT NULL DEFAULT 0,
    source_done INTEGER NOT NULL DEFAULT 0,
    replay_done INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'retrying', 'unsupported', 'complete')
    ),
    reason TEXT
  )`,
  },
  {
    name: 'usage_capture_rows',
    ddl: `CREATE TABLE IF NOT EXISTS usage_capture_rows (
    session_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    fingerprint TEXT,
    event_payload TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, source_key)
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

const AUTOMATIONS_TABLE: TableSchema = {
  name: 'automations',
  ddl: `CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('short', 'long')),
    status TEXT NOT NULL CHECK (
      status IN (
        'active', 'paused', 'needs-auth', 'completed', 'failed', 'cancelled'
      )
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
  )`,
};

const AUTOMATION_TABLES: readonly TableSchema[] = [
  AUTOMATIONS_TABLE,
  {
    name: 'automation_runs',
    ddl: `CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'scheduled' CHECK (
      source IN ('scheduled', 'manual')
    ),
    phase TEXT NOT NULL DEFAULT 'finished' CHECK (
      phase IN (
        'queued', 'checking', 'acting', 'finished',
        'cancelled', 'interrupted', 'uncertain'
      )
    ),
    scheduled_for_at TEXT,
    occurrence_key TEXT,
    dedupe_key TEXT,
    started_at TEXT NOT NULL,
    dispatched_at TEXT,
    ended_at TEXT,
    triggered INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
    detail TEXT,
    session_id TEXT,
    report TEXT,
    acknowledged_run_ids TEXT,
    acknowledged_snapshot_run_ids TEXT,
    resolved_by_run_id TEXT
  )`,
  },
  {
    name: 'subagents',
    ddl: `CREATE TABLE IF NOT EXISTS subagents (
    id TEXT PRIMARY KEY,
    automation_id TEXT,
    origin_session_id TEXT,
    origin_feature_id TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('queued', 'running', 'done', 'failed')
    ),
    progress TEXT,
    result TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
  { schema: 'automations', file: 'automations.db', tables: AUTOMATION_TABLES },
];

/**
 * Flat DDL for every table, retained for callers/tests that want the raw
 * `CREATE TABLE` statements independent of the multi-file layout.
 */
export const SCHEMA_STATEMENTS: readonly string[] = DATABASE_GROUPS.flatMap((group) =>
  group.tables.map((table) => table.ddl),
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
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_usage_events_session_started_at ON usage_events (session_id, started_at)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_meta_usage_records_feature_id ON meta_usage_records (feature_id)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_meta_operations_feature ON meta_operations (feature_id, operation_id)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_meta_operations_automation ON meta_operations (automation_id, operation_id)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_meta_operations_session ON meta_operations (session_id, operation_id)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_meta_operations_origin_session ON meta_operations (origin_session_id, operation_id)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_meta_operations_state ON meta_operations (state, operation_id)',
  },
  {
    schema: 'usage',
    ddl: 'CREATE INDEX IF NOT EXISTS usage.idx_meta_operation_sessions_operation ON meta_operation_sessions (operation_id)',
  },
  {
    schema: 'usage',
    ddl: "CREATE INDEX IF NOT EXISTS usage.idx_usage_capture_state_status ON usage_capture_state (status, session_id)",
  },
  {
    schema: 'usage',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS usage.${USAGE_CAPTURE_ROWS_TURN_INDEX} ON usage_capture_rows (session_id, turn_index)`,
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
  {
    schema: 'automations',
    ddl: 'CREATE INDEX IF NOT EXISTS automations.idx_automation_runs_automation_id ON automation_runs (automation_id)',
  },
  {
    schema: 'automations',
    ddl:
      "CREATE UNIQUE INDEX IF NOT EXISTS automations.idx_automation_runs_open_automation_id ON automation_runs (automation_id) WHERE phase IN ('queued', 'checking', 'acting')",
  },
  {
    schema: 'automations',
    ddl:
      "CREATE INDEX IF NOT EXISTS automations.idx_automation_runs_open_phase ON automation_runs (phase, started_at, id)",
  },
  {
    schema: 'automations',
    ddl: 'CREATE INDEX IF NOT EXISTS automations.idx_subagents_automation_id ON subagents (automation_id)',
  },
];

/** Flat index DDL, retained for callers/tests that want the raw statements. */
export const INDEX_STATEMENTS: readonly string[] = INDEXES.map((index) => index.ddl);

/**
 * Columns added after a table's initial release. `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so these are applied idempotently for
 * databases created before the column existed. Most retrofitted tables live in
 * the `main` file; attached-group tables carry an explicit `schema`.
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
    table: 'features',
    column: 'parent_feature_id',
    ddl: 'ALTER TABLE features ADD COLUMN parent_feature_id TEXT',
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
    table: 'automation_runs',
    schema: 'automations',
    column: 'source',
    ddl:
      "ALTER TABLE automations.automation_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'scheduled'",
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'phase',
    ddl:
      "ALTER TABLE automations.automation_runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'finished'",
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'scheduled_for_at',
    ddl: 'ALTER TABLE automations.automation_runs ADD COLUMN scheduled_for_at TEXT',
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'occurrence_key',
    ddl: 'ALTER TABLE automations.automation_runs ADD COLUMN occurrence_key TEXT',
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'dedupe_key',
    ddl: 'ALTER TABLE automations.automation_runs ADD COLUMN dedupe_key TEXT',
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'dispatched_at',
    ddl: 'ALTER TABLE automations.automation_runs ADD COLUMN dispatched_at TEXT',
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'acknowledged_run_ids',
    ddl: 'ALTER TABLE automations.automation_runs ADD COLUMN acknowledged_run_ids TEXT',
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'acknowledged_snapshot_run_ids',
    ddl:
      'ALTER TABLE automations.automation_runs ADD COLUMN acknowledged_snapshot_run_ids TEXT',
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'resolved_by_run_id',
    ddl: 'ALTER TABLE automations.automation_runs ADD COLUMN resolved_by_run_id TEXT',
  },
  {
    table: 'automation_runs',
    schema: 'automations',
    column: 'report',
    ddl: 'ALTER TABLE automations.automation_runs ADD COLUMN report TEXT',
  },
  {
    table: 'usage_capture_state',
    schema: 'usage',
    column: 'replay_cursor',
    ddl: 'ALTER TABLE usage.usage_capture_state ADD COLUMN replay_cursor INTEGER',
  },
  {
    table: 'usage_capture_state',
    schema: 'usage',
    column: 'final_scan',
    ddl: 'ALTER TABLE usage.usage_capture_state ADD COLUMN final_scan INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'usage_capture_state',
    schema: 'usage',
    column: 'replay_clean',
    ddl: 'ALTER TABLE usage.usage_capture_state ADD COLUMN replay_clean INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'usage_capture_state',
    schema: 'usage',
    column: 'source_done',
    ddl: 'ALTER TABLE usage.usage_capture_state ADD COLUMN source_done INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'usage_capture_state',
    schema: 'usage',
    column: 'replay_done',
    ddl: 'ALTER TABLE usage.usage_capture_state ADD COLUMN replay_done INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'usage_capture_rows',
    schema: 'usage',
    column: 'event_payload',
    ddl: "ALTER TABLE usage.usage_capture_rows ADD COLUMN event_payload TEXT NOT NULL DEFAULT ''",
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

interface TableCopyVersion {
  readonly name: string;
  readonly sourceColumns: readonly string[];
  readonly selectExpressions: readonly string[];
}

interface TableCopyPlan {
  readonly sourceSchema: string;
  readonly sourceTable: string;
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly targetColumns: readonly string[];
  readonly primaryKey: readonly string[];
  readonly versions: readonly TableCopyVersion[];
  readonly backupSourceSchema: string;
  readonly backupSourceTable: string;
}

interface ManagedMigration {
  readonly id: string;
  readonly description: string;
  readonly backupSchemas: readonly string[];
  requiresMigration(db: DatabaseSync): boolean;
  run(db: DatabaseSync, context: ManagedMigrationContext, options: ApplySchemaOptions): void;
  verifyRecoveredTarget(db: DatabaseSync, backupPath: string): void;
}

interface ManagedMigrationContext {
  backupPath: string | null;
}

interface MigrationBackupManifest {
  readonly migrationId: string;
  readonly entries: readonly {
    schema: string;
    livePath: string;
    backupFile: string;
  }[];
}

interface MigrationJournalRow {
  readonly migrationId: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly active_stage: string | null;
  readonly backup_path: string | null;
  readonly last_error: string | null;
}

export interface SchemaStageInfo {
  readonly migrationId: string;
  readonly stage: string;
}

export interface SchemaStageHooks {
  beforeStage?(info: SchemaStageInfo): void;
  afterStage?(info: SchemaStageInfo): void;
}

export interface ApplySchemaOptions {
  readonly stageHooks?: SchemaStageHooks;
}

const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';
const SCHEMA_MIGRATION_STAGES_TABLE = 'schema_migration_stages';
const MIGRATION_BACKUP_DIRECTORY = 'migration-backups';
const LEGACY_AUTOMATIONS_TABLE = 'automations_legacy';

/** Names of the databases currently attached to the connection. */
function attachedSchemas(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Whether a table exists in a specific attached database. */
function tableExistsIn(db: DatabaseSync, schema: string, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

function indexExistsIn(db: DatabaseSync, schema: string, index: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'index' AND name = ?`)
    .get(index);
  return row !== undefined;
}

function tableColumns(db: DatabaseSync, schema: string, table: string): string[] {
  return (
    db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((column) => right.includes(column)) &&
    right.every((column) => left.includes(column))
  );
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

/** Adds a column to an existing table when it is missing. */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
  schema?: string,
): void {
  const targetSchema = schema ?? 'main';
  const columns = tableColumns(db, targetSchema, table);
  if (!columns.includes(column)) {
    db.exec(ddl);
  }
}

function defineVersion(
  name: string,
  sourceColumns: readonly string[],
  selectExpressions: readonly string[] = sourceColumns,
): TableCopyVersion {
  return { name, sourceColumns, selectExpressions };
}

function detectCopyVersion(db: DatabaseSync, plan: TableCopyPlan): TableCopyVersion {
  const sourceColumns = tableColumns(db, plan.sourceSchema, plan.sourceTable);
  const version = plan.versions.find((candidate) =>
    sameColumns(candidate.sourceColumns, sourceColumns),
  );
  if (version) {
    return version;
  }
  throw new Error(
    `Unsupported legacy schema for ${plan.sourceSchema}.${plan.sourceTable}: ` +
      `${sourceColumns.join(', ')}`,
  );
}

function buildProjectionSelect(plan: TableCopyPlan, version: TableCopyVersion): string {
  const selectList = plan.targetColumns
    .map((column, index) => `${version.selectExpressions[index]} AS ${column}`)
    .join(', ');
  return `SELECT ${selectList} FROM ${plan.sourceSchema}.${plan.sourceTable}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function insertMissingRows(
  db: DatabaseSync,
  plan: TableCopyPlan,
  version: TableCopyVersion,
): void {
  const columns = plan.targetColumns.join(', ');
  const projection = buildProjectionSelect(plan, version);
  const primaryKeyMatch = plan.primaryKey
    .map((column) => `target.${column} = projected.${column}`)
    .join(' AND ');
  db.exec(`INSERT INTO ${plan.targetSchema}.${plan.targetTable} (${columns})
    SELECT ${columns}
    FROM (${projection}) AS projected
    WHERE NOT EXISTS (
      SELECT 1 FROM ${plan.targetSchema}.${plan.targetTable} AS target
      WHERE ${primaryKeyMatch}
    )`);
}

function countRows(db: DatabaseSync, sql: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get() as { n: number }).n;
}

function hasProjectedDifference(
  db: DatabaseSync,
  leftSql: string,
  rightSql: string,
): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM (${leftSql} EXCEPT ${rightSql}) LIMIT 1`)
      .get() !== undefined
  );
}

function verifyCopiedRows(
  db: DatabaseSync,
  plan: TableCopyPlan,
  version: TableCopyVersion,
): void {
  const columns = plan.targetColumns.join(', ');
  const projection = buildProjectionSelect(plan, version);
  const sourceSql = `SELECT ${columns} FROM (${projection}) AS projected`;
  const targetSql = `SELECT ${columns} FROM ${plan.targetSchema}.${plan.targetTable}`;
  const sourceCount = countRows(db, sourceSql);
  const targetCount = countRows(db, targetSql);
  if (sourceCount !== targetCount) {
    throw new Error(
      `Projected ${plan.sourceSchema}.${plan.sourceTable} (${version.name}) has ` +
        `${sourceCount} rows but ${plan.targetSchema}.${plan.targetTable} has ` +
        `${targetCount} rows`,
    );
  }
  if (
    hasProjectedDifference(db, sourceSql, targetSql) ||
    hasProjectedDifference(db, targetSql, sourceSql)
  ) {
    throw new Error(
      `Projected ${plan.sourceSchema}.${plan.sourceTable} (${version.name}) ` +
        `conflicts with existing rows in ${plan.targetSchema}.${plan.targetTable}`,
    );
  }
}

function tableSql(db: DatabaseSync, schema: string, table: string): string {
  return (db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string }).sql;
}

function automationsStatusNeedsAuthAllowed(db: DatabaseSync): boolean {
  return tableSql(db, 'automations', 'automations').includes("'needs-auth'");
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupDirectoryFor(db: DatabaseSync, migrationId: string): string | null {
  const mainPath = db.location('main');
  if (mainPath === null) {
    return null;
  }
  return join(dirname(mainPath), MIGRATION_BACKUP_DIRECTORY, migrationId);
}

function ensureMigrationBackup(
  db: DatabaseSync,
  migration: ManagedMigration,
): string | null {
  const backupDirectory = backupDirectoryFor(db, migration.id);
  if (backupDirectory === null) {
    return null;
  }
  const manifestPath = join(backupDirectory, 'manifest.json');
  if (existsSync(manifestPath)) {
    return backupDirectory;
  }

  rmSync(backupDirectory, { recursive: true, force: true });
  mkdirSync(backupDirectory, { recursive: true });

  const entries = migration.backupSchemas.map((schema) => {
    const livePath = db.location(schema);
    if (livePath === null) {
      throw new Error(`Cannot back up in-memory schema ${schema}`);
    }
    const backupFile = basename(livePath);
    db.exec(`VACUUM ${schema} INTO ${sqliteStringLiteral(join(backupDirectory, backupFile))}`);
    return { schema, livePath, backupFile };
  });

  const manifest: MigrationBackupManifest = {
    migrationId: migration.id,
    entries,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return backupDirectory;
}

function readMigrationBackupManifest(backupDirectory: string): MigrationBackupManifest {
  return JSON.parse(
    readFileSync(join(backupDirectory, 'manifest.json'), 'utf8'),
  ) as MigrationBackupManifest;
}

/**
 * Restores a migration backup created by {@link applySchema}. The caller must
 * ensure all connections to the live files are closed before invoking this.
 */
export function restoreMigrationBackup(backupDirectory: string): void {
  const manifest = readMigrationBackupManifest(backupDirectory);
  for (const entry of manifest.entries) {
    copyFileSync(join(backupDirectory, entry.backupFile), entry.livePath);
    rmSync(`${entry.livePath}-wal`, { force: true });
    rmSync(`${entry.livePath}-shm`, { force: true });
  }
}

function readMigrationJournal(
  db: DatabaseSync,
  migrationId: string,
): MigrationJournalRow | null {
  return (
    (db
      .prepare(
        `SELECT migration_id AS migrationId,
                status,
                active_stage,
                backup_path,
                last_error
         FROM main.${SCHEMA_MIGRATIONS_TABLE}
         WHERE migration_id = ?`,
      )
      .get(migrationId) as MigrationJournalRow | undefined) ?? null
  );
}

function ensureMigrationJournalTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS main.${SCHEMA_MIGRATIONS_TABLE} (
    migration_id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    active_stage TEXT,
    backup_path TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS main.${SCHEMA_MIGRATION_STAGES_TABLE} (
    migration_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (migration_id, stage)
  )`);
}

function beginMigration(db: DatabaseSync, migration: ManagedMigration): void {
  db.prepare(
    `INSERT INTO main.${SCHEMA_MIGRATIONS_TABLE}
      (migration_id, description, status, active_stage, backup_path, last_error, updated_at)
      VALUES (?, ?, 'running', NULL, NULL, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(migration_id) DO UPDATE SET
        description = excluded.description,
        status = 'running',
        active_stage = NULL,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP`,
  ).run(migration.id, migration.description);
}

function setMigrationBackupPath(
  db: DatabaseSync,
  migrationId: string,
  backupPath: string | null,
): void {
  db.prepare(
    `UPDATE main.${SCHEMA_MIGRATIONS_TABLE}
      SET backup_path = ?, updated_at = CURRENT_TIMESTAMP
      WHERE migration_id = ?`,
  ).run(backupPath, migrationId);
}

function markStageRunning(
  db: DatabaseSync,
  migrationId: string,
  stage: string,
  detail: string,
): void {
  db.prepare(
    `INSERT INTO main.${SCHEMA_MIGRATION_STAGES_TABLE}
      (migration_id, stage, status, detail, updated_at)
      VALUES (?, ?, 'running', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(migration_id, stage) DO UPDATE SET
        status = 'running',
        detail = excluded.detail,
        updated_at = CURRENT_TIMESTAMP`,
  ).run(migrationId, stage, detail);
  db.prepare(
    `UPDATE main.${SCHEMA_MIGRATIONS_TABLE}
      SET active_stage = ?, status = 'running', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE migration_id = ?`,
  ).run(stage, migrationId);
}

function markStageCompleted(
  db: DatabaseSync,
  migrationId: string,
  stage: string,
  detail: string,
): void {
  db.prepare(
    `UPDATE main.${SCHEMA_MIGRATION_STAGES_TABLE}
      SET status = 'completed', detail = ?, updated_at = CURRENT_TIMESTAMP
      WHERE migration_id = ? AND stage = ?`,
  ).run(detail, migrationId, stage);
}

function markMigrationFailed(
  db: DatabaseSync,
  migrationId: string,
  stage: string,
  message: string,
): void {
  db.prepare(
    `UPDATE main.${SCHEMA_MIGRATION_STAGES_TABLE}
      SET status = 'failed', detail = ?, updated_at = CURRENT_TIMESTAMP
      WHERE migration_id = ? AND stage = ?`,
  ).run(message, migrationId, stage);
  db.prepare(
    `UPDATE main.${SCHEMA_MIGRATIONS_TABLE}
      SET status = 'failed',
          active_stage = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE migration_id = ?`,
  ).run(stage, message, migrationId);
}

function markMigrationCompleted(db: DatabaseSync, migrationId: string): void {
  db.prepare(
    `UPDATE main.${SCHEMA_MIGRATIONS_TABLE}
      SET status = 'completed',
          active_stage = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE migration_id = ?`,
  ).run(migrationId);
}

function markInterruptedMigrationFailed(
  db: DatabaseSync,
  journal: MigrationJournalRow,
  message: string,
): void {
  if (journal.active_stage === null) {
    db.prepare(
      `UPDATE main.${SCHEMA_MIGRATIONS_TABLE}
        SET status = 'failed',
            last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE migration_id = ?`,
    ).run(message, journal.migrationId);
    return;
  }
  markMigrationFailed(db, journal.migrationId, journal.active_stage, message);
}

function recoveryStageDetail(backupPath: string): string {
  return `Re-verified the replacement state from recorded backup ${backupPath} after the legacy source was already absent.`;
}

function backupAlias(migrationId: string, schema: string): string {
  return `backup_${migrationId.replaceAll(/[^A-Za-z0-9_]/g, '_')}_${schema}`;
}

function withAttachedBackupSchema<T>(
  db: DatabaseSync,
  migrationId: string,
  backupDirectory: string,
  schema: string,
  action: (backupSchema: string) => T,
): T {
  const manifest = readMigrationBackupManifest(backupDirectory);
  const entry = manifest.entries.find((candidate) => candidate.schema === schema);
  if (!entry) {
    throw new Error(`Backup ${backupDirectory} does not include schema ${schema}`);
  }
  const backupFile = join(backupDirectory, entry.backupFile);
  if (!existsSync(backupFile)) {
    throw new Error(`Backup file missing: ${backupFile}`);
  }
  const alias = backupAlias(migrationId, schema);
  db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(backupFile);
  try {
    return action(alias);
  } finally {
    db.exec(`DETACH DATABASE ${alias}`);
  }
}

function verifyRecoveredTargetFromBackup(
  db: DatabaseSync,
  migrationId: string,
  backupDirectory: string,
  plan: TableCopyPlan,
): void {
  withAttachedBackupSchema(
    db,
    migrationId,
    backupDirectory,
    plan.backupSourceSchema,
    (backupSchema) => {
      const verificationPlan: TableCopyPlan = {
        ...plan,
        sourceSchema: backupSchema,
        sourceTable: plan.backupSourceTable,
      };
      verifyCopiedRows(
        db,
        verificationPlan,
        detectCopyVersion(db, verificationPlan),
      );
    },
  );
}

function finalizeRecoveredMigration(
  db: DatabaseSync,
  migration: ManagedMigration,
  journal: MigrationJournalRow,
): void {
  const backupInstruction =
    journal.backup_path === null
      ? 'No recorded backup is available.'
      : `Restore the recorded backup with restoreMigrationBackup('${journal.backup_path.replaceAll("'", "''")}') and rerun.`;
  try {
    if (journal.backup_path === null) {
      throw new Error('Missing recorded backup path');
    }
    migration.verifyRecoveredTarget(db, journal.backup_path);
  } catch (error) {
    const message =
      `Schema migration ${migration.id} is still incomplete: its legacy source is already ` +
      `absent, so the replacement could not be re-verified. ${backupInstruction} ` +
      `Cause: ${errorMessage(error)}`;
    markInterruptedMigrationFailed(db, journal, message);
    throw new Error(message);
  }

  if (journal.active_stage !== null) {
    const detail = recoveryStageDetail(journal.backup_path);
    markStageCompleted(db, journal.migrationId, journal.active_stage, detail);
  }
  markMigrationCompleted(db, journal.migrationId);
}

function runMigrationStage(
  db: DatabaseSync,
  migration: ManagedMigration,
  stage: string,
  detail: string,
  context: ManagedMigrationContext,
  options: ApplySchemaOptions,
  action: () => void,
): void {
  markStageRunning(db, migration.id, stage, detail);
  const info: SchemaStageInfo = { migrationId: migration.id, stage };
  try {
    options.stageHooks?.beforeStage?.(info);
    action();
    options.stageHooks?.afterStage?.(info);
    markStageCompleted(db, migration.id, stage, detail);
  } catch (error) {
    const message =
      `Schema migration ${migration.id} failed at stage "${stage}" (${detail}). ` +
      `Backup: ${context.backupPath ?? 'not-created'}. ` +
      `Legacy rows are only discarded after the drop-source stage succeeds. ` +
      `Cause: ${errorMessage(error)}`;
    markMigrationFailed(db, migration.id, stage, message);
    throw new Error(message);
  }
}

function runCopyMigration(
  db: DatabaseSync,
  migration: ManagedMigration,
  plan: TableCopyPlan,
  context: ManagedMigrationContext,
  options: ApplySchemaOptions,
): void {
  let version!: TableCopyVersion;
  runMigrationStage(
    db,
    migration,
    'backup',
    `Backing up ${migration.backupSchemas.join(', ')}`,
    context,
    options,
    () => {
      context.backupPath = ensureMigrationBackup(db, migration);
      setMigrationBackupPath(db, migration.id, context.backupPath);
    },
  );
  runMigrationStage(
    db,
    migration,
    'copy',
    `Copying ${plan.sourceSchema}.${plan.sourceTable} into ${plan.targetSchema}.${plan.targetTable}`,
    context,
    options,
    () => {
      version = detectCopyVersion(db, plan);
      insertMissingRows(db, plan, version);
    },
  );
  runMigrationStage(
    db,
    migration,
    'verify',
    `Verifying ${plan.targetSchema}.${plan.targetTable} matches the legacy source`,
    context,
    options,
    () => {
      verifyCopiedRows(db, plan, version);
    },
  );
  runMigrationStage(
    db,
    migration,
    'drop-source',
    `Dropping ${plan.sourceSchema}.${plan.sourceTable}`,
    context,
    options,
    () => {
      db.exec(`DROP TABLE ${plan.sourceSchema}.${plan.sourceTable}`);
    },
  );
}

function relocationMigration(
  targetSchema: string,
  targetTable: string,
  targetColumns: readonly string[],
  primaryKey: readonly string[],
  versions: readonly TableCopyVersion[],
): ManagedMigration {
  const plan: TableCopyPlan = {
    sourceSchema: 'main',
    sourceTable: targetTable,
    targetSchema,
    targetTable,
    targetColumns,
    primaryKey,
    versions,
    backupSourceSchema: 'main',
    backupSourceTable: targetTable,
  };
  return {
    id: `relocate-${targetSchema}-${targetTable}`,
    description: `Relocate legacy main.${targetTable} into ${targetSchema}.${targetTable}`,
    backupSchemas: ['main', targetSchema],
    requiresMigration(db) {
      return tableExistsIn(db, 'main', targetTable);
    },
    run(db, context, options) {
      runCopyMigration(db, this, plan, context, options);
    },
    verifyRecoveredTarget(db, backupPath) {
      verifyRecoveredTargetFromBackup(db, this.id, backupPath, plan);
    },
  };
}

const RELOCATION_MIGRATIONS: readonly ManagedMigration[] = [
  relocationMigration(
    'usage',
    'usage_events',
    USAGE_EVENTS_COLUMNS,
    ['session_id', 'turn_index'],
    [defineVersion('current', USAGE_EVENTS_COLUMNS)],
  ),
  relocationMigration(
    'content',
    'transcripts',
    TRANSCRIPTS_COLUMNS,
    ['session_id'],
    [defineVersion('current', TRANSCRIPTS_COLUMNS)],
  ),
  relocationMigration(
    'content',
    'summaries',
    SUMMARIES_COLUMNS,
    ['feature_id'],
    [defineVersion('current', SUMMARIES_COLUMNS)],
  ),
  relocationMigration(
    'content',
    'session_summaries',
    SESSION_SUMMARIES_COLUMNS,
    ['session_id'],
    [defineVersion('current', SESSION_SUMMARIES_COLUMNS)],
  ),
  relocationMigration(
    'content',
    'session_files',
    SESSION_FILES_COLUMNS,
    ['session_id', 'path'],
    [defineVersion('current', SESSION_FILES_COLUMNS)],
  ),
  relocationMigration(
    'content',
    'pr_reviews',
    PR_REVIEW_COLUMNS,
    ['feature_id'],
    [
      defineVersion('current', PR_REVIEW_COLUMNS),
      defineVersion('pre-document', LEGACY_PR_REVIEW_COLUMNS, [
        'feature_id',
        'repo_id',
        'pull_number',
        'pull_title',
        'pull_url',
        'worktree_path',
        'base_branch',
        'status',
        'summary',
        'core_analysis',
        'changed_files',
        'created_at',
        'updated_at',
        'generated_at',
        'failure_message',
        'failed_at',
        'NULL',
      ]),
    ],
  ),
  relocationMigration(
    'tasks',
    'feature_tasks',
    FEATURE_TASK_COLUMNS,
    ['id'],
    [defineVersion('current', FEATURE_TASK_COLUMNS)],
  ),
  relocationMigration(
    'automations',
    'automation_runs',
    AUTOMATION_RUN_COLUMNS,
    ['id'],
    [
      defineVersion('current', AUTOMATION_RUN_COLUMNS),
      defineVersion(
        'pre-wp07-durable-occurrences',
        [
          'id',
          'automation_id',
          'started_at',
          'ended_at',
          'triggered',
          'status',
          'detail',
          'session_id',
        ],
        [
          'id',
          'automation_id',
          "'scheduled'",
          "'finished'",
          'NULL',
          'NULL',
          'NULL',
          'started_at',
          'started_at',
          'ended_at',
          'triggered',
          'status',
          'detail',
          'session_id',
          'NULL',
          'NULL',
          'NULL',
          'NULL',
        ],
      ),
    ],
  ),
  relocationMigration(
    'automations',
    'subagents',
    SUBAGENT_COLUMNS,
    ['id'],
    [defineVersion('current', SUBAGENT_COLUMNS)],
  ),
];

const AUTOMATIONS_STATUS_PLAN: TableCopyPlan = {
  sourceSchema: 'automations',
  sourceTable: LEGACY_AUTOMATIONS_TABLE,
  targetSchema: 'automations',
  targetTable: 'automations',
  targetColumns: AUTOMATIONS_COLUMNS,
  primaryKey: ['id'],
  versions: [defineVersion('pre-needs-auth-status', AUTOMATIONS_COLUMNS)],
  backupSourceSchema: 'automations',
  backupSourceTable: AUTOMATIONS_TABLE.name,
};

const AUTOMATIONS_STATUS_MIGRATION: ManagedMigration = {
  id: 'rebuild-automations-needs-auth-status',
  description: 'Rebuild legacy automations table so the needs-auth status is allowed',
  backupSchemas: ['automations'],
  requiresMigration(db) {
    return (
      tableExistsIn(db, 'automations', LEGACY_AUTOMATIONS_TABLE) ||
      !automationsStatusNeedsAuthAllowed(db)
    );
  },
  run(db, context, options) {
    runMigrationStage(
      db,
      this,
      'backup',
      'Backing up automations before rebuilding the status constraint',
      context,
      options,
      () => {
        context.backupPath = ensureMigrationBackup(db, this);
        setMigrationBackupPath(db, this.id, context.backupPath);
      },
    );
    runMigrationStage(
      db,
      this,
      'rename-legacy',
      'Renaming automations.automations to automations_legacy',
      context,
      options,
      () => {
        if (!tableExistsIn(db, 'automations', LEGACY_AUTOMATIONS_TABLE)) {
          db.exec(
            `ALTER TABLE automations.automations RENAME TO ${LEGACY_AUTOMATIONS_TABLE}`,
          );
        }
      },
    );
    runMigrationStage(
      db,
      this,
      'create-target',
      'Creating the replacement automations.automations table',
      context,
      options,
      () => {
        db.exec(qualifyTable('automations', AUTOMATIONS_TABLE));
      },
    );
    runMigrationStage(
      db,
      this,
      'copy',
      'Copying legacy automations rows into the replacement table',
      context,
      options,
      () => {
        insertMissingRows(db, AUTOMATIONS_STATUS_PLAN, AUTOMATIONS_STATUS_PLAN.versions[0]);
      },
    );
    runMigrationStage(
      db,
      this,
      'verify',
      'Verifying the rebuilt automations table matches the legacy rows',
      context,
      options,
      () => {
        verifyCopiedRows(
          db,
          AUTOMATIONS_STATUS_PLAN,
          AUTOMATIONS_STATUS_PLAN.versions[0],
        );
      },
    );
    runMigrationStage(
      db,
      this,
      'drop-source',
      'Dropping automations.automations_legacy',
      context,
      options,
      () => {
        db.exec(`DROP TABLE automations.${LEGACY_AUTOMATIONS_TABLE}`);
      },
    );
  },
  verifyRecoveredTarget(db, backupPath) {
    verifyRecoveredTargetFromBackup(
      db,
      this.id,
      backupPath,
      AUTOMATIONS_STATUS_PLAN,
    );
  },
};

const MANAGED_MIGRATIONS: readonly ManagedMigration[] = [
  ...RELOCATION_MIGRATIONS,
  AUTOMATIONS_STATUS_MIGRATION,
];

/** Applies the schema across the primary and attached databases. */
export function applySchema(
  db: DatabaseSync,
  options: ApplySchemaOptions = {},
): void {
  ensureGroupsAttached(db);
  for (const group of DATABASE_GROUPS) {
    for (const table of group.tables) {
      const ddl = group.schema === 'main' ? table.ddl : qualifyTable(group.schema, table);
      if (table.initialize !== undefined && !tableExistsIn(db, group.schema, table.name)) {
        db.exec('SAVEPOINT initialize_schema_table');
        try {
          db.exec(ddl);
          db.exec(table.initialize);
          db.exec('RELEASE initialize_schema_table');
        } catch (error) {
          db.exec('ROLLBACK TO initialize_schema_table; RELEASE initialize_schema_table');
          throw error;
        }
      } else {
        db.exec(ddl);
      }
    }
  }
  ensureMigrationJournalTables(db);
  for (const { table, column, ddl, schema } of ADDED_COLUMNS) {
    addColumnIfMissing(db, table, column, ddl, schema);
  }
  if (indexExistsIn(db, 'usage', LEGACY_USAGE_CAPTURE_ROWS_TURN_INDEX)) {
    db.exec(`DROP INDEX usage.${LEGACY_USAGE_CAPTURE_ROWS_TURN_INDEX}`);
  }
  for (const migration of MANAGED_MIGRATIONS) {
    const journal = readMigrationJournal(db, migration.id);
    if (!migration.requiresMigration(db)) {
      if (journal !== null && journal.status !== 'completed') {
        finalizeRecoveredMigration(db, migration, journal);
      }
      continue;
    }
    beginMigration(db, migration);
    migration.run(db, { backupPath: null }, options);
    markMigrationCompleted(db, migration.id);
  }
  for (const index of INDEXES) {
    db.exec(index.ddl);
  }
}
