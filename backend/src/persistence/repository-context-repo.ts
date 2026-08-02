import type { DatabaseSync } from 'node:sqlite';
import type {
  RepositoryContext,
  RepositoryContextStatus,
  RepositoryContextStep,
} from '../repository-context/repository-context-contract.js';
import type { RepositoryContextRepo } from '../repository-context/repository-context-repo-port.js';

interface RepositoryContextRow {
  repo_id: string;
  status: string;
  content: string | null;
  source_revision: string | null;
  created_at: string;
  updated_at: string;
  generation_started_at: string | null;
  generated_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failed_at: string | null;
  failure_retryable: number | null;
  failure_step: string | null;
  steps: string | null;
}

function parseSteps(raw: string | null): RepositoryContextStep[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RepositoryContextStep[]) : [];
  } catch {
    return [];
  }
}

function mapRepositoryContext(row: RepositoryContextRow): RepositoryContext {
  const hasFailure =
    row.failure_code !== null &&
    row.failure_message !== null &&
    row.failed_at !== null &&
    row.failure_retryable !== null;

  return {
    repositoryId: row.repo_id,
    status: row.status as RepositoryContextStatus,
    content: row.content,
    sourceRevision: row.source_revision,
    timestamps: {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      generationStartedAt: row.generation_started_at,
      generatedAt: row.generated_at,
    },
    steps: parseSteps(row.steps),
    failure: hasFailure
      ? {
          code: row.failure_code as string,
          message: row.failure_message as string,
          failedAt: row.failed_at as string,
          retryable: row.failure_retryable === 1,
          step: row.failure_step,
        }
      : null,
  };
}

/** SQLite-backed implementation of repository context lifecycle persistence. */
export function createRepositoryContextRepo(db: DatabaseSync): RepositoryContextRepo {
  const upsert = db.prepare(
    `INSERT INTO repository_contexts (
       repo_id, status, content, source_revision, created_at, updated_at,
       generation_started_at, generated_at, failure_code, failure_message,
       failed_at, failure_retryable, failure_step, steps
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       status = excluded.status,
       content = COALESCE(excluded.content, repository_contexts.content),
       source_revision = COALESCE(
         excluded.source_revision,
         repository_contexts.source_revision
       ),
       updated_at = excluded.updated_at,
       generation_started_at = excluded.generation_started_at,
       generated_at = COALESCE(excluded.generated_at, repository_contexts.generated_at),
       failure_code = excluded.failure_code,
       failure_message = excluded.failure_message,
       failed_at = excluded.failed_at,
       failure_retryable = excluded.failure_retryable,
       failure_step = excluded.failure_step,
       steps = excluded.steps`,
  );
  const selectOne = db.prepare(
    'SELECT * FROM repository_contexts WHERE repo_id = ?',
  );
  const selectAll = db.prepare(
    'SELECT * FROM repository_contexts ORDER BY created_at, repo_id',
  );
  const deleteOne = db.prepare(
    'DELETE FROM repository_contexts WHERE repo_id = ?',
  );

  return {
    get(repositoryId) {
      const row = selectOne.get(repositoryId) as RepositoryContextRow | undefined;
      return row ? mapRepositoryContext(row) : null;
    },
    list() {
      return (selectAll.all() as unknown as RepositoryContextRow[]).map(
        mapRepositoryContext,
      );
    },
    save(context) {
      upsert.run(
        context.repositoryId,
        context.status,
        context.content,
        context.sourceRevision,
        context.timestamps.createdAt,
        context.timestamps.updatedAt,
        context.timestamps.generationStartedAt,
        context.timestamps.generatedAt,
        context.failure?.code ?? null,
        context.failure?.message ?? null,
        context.failure?.failedAt ?? null,
        context.failure === null ? null : Number(context.failure.retryable),
        context.failure?.step ?? null,
        JSON.stringify(context.steps),
      );
    },
    delete(repositoryId) {
      deleteOne.run(repositoryId);
    },
  };
}
