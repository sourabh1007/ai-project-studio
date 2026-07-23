import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ImportableSession } from '../provider-contract.js';

export interface CliSessionStoreDeps {
  /** Absolute path to the CLI's session-store.db. */
  databasePath: string;
  /** Provider id stamped onto each importable session. */
  provider: string;
  /** Max sessions returned (newest first). */
  limit: number;
  /** Max characters of the derived title. */
  maxTitleChars: number;
  /** Title used when a session has neither a summary nor a first message. */
  emptyTitlePlaceholder: string;
}

interface CliSessionRow {
  id: string;
  summary: string | null;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  model: string | null;
  first_message: string | null;
}

/**
 * Lists past sessions the Copilot/Agency CLI recorded in its own
 * `session-store.db`, shaped as {@link ImportableSession}s for the import flow.
 * Opens the store read-only per call (WAL-safe while the CLI keeps writing) and
 * degrades to an empty list on any failure — missing file, lock, schema drift —
 * so importing never breaks because of the external store.
 */
export interface CliSessionStore {
  available(): boolean;
  listImportable(): ImportableSession[];
}

/** Picks a human-friendly title, preferring the CLI summary, then first line
 * of the first user message, then the configured placeholder. Truncated to the
 * configured maximum with an ellipsis. */
export function deriveTitle(
  row: Pick<CliSessionRow, 'summary' | 'first_message'>,
  maxChars: number,
  placeholder: string,
): string {
  const source =
    firstNonEmpty(row.summary) ??
    firstLine(firstNonEmpty(row.first_message)) ??
    placeholder;
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function firstNonEmpty(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstLine(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.split('\n')[0].trim();
}

export function createCliSessionStore(
  deps: CliSessionStoreDeps,
): CliSessionStore {
  function rows(): CliSessionRow[] {
    if (!existsSync(deps.databasePath)) {
      return [];
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(deps.databasePath, { readOnly: true });
    } catch {
      return [];
    }
    try {
      const result = db
        .prepare(
          `SELECT s.id, s.summary, s.cwd, s.repository, s.branch,
                  s.created_at, s.updated_at,
                  (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id)
                    AS message_count,
                  (SELECT a.model FROM assistant_usage_events a
                     WHERE a.session_id = s.id
                     ORDER BY a.created_at DESC LIMIT 1) AS model,
                  (SELECT tt.user_message FROM turns tt
                     WHERE tt.session_id = s.id
                     ORDER BY tt.turn_index ASC LIMIT 1) AS first_message
           FROM sessions s
           WHERE (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) > 0
              OR s.summary IS NOT NULL
           ORDER BY s.updated_at DESC
           LIMIT ?`,
        )
        .all(deps.limit) as unknown as CliSessionRow[];
      db.close();
      return result;
    } catch {
      db.close();
      return [];
    }
  }

  return {
    available() {
      return existsSync(deps.databasePath);
    },
    listImportable() {
      return rows().map((row) => ({
        externalId: row.id,
        provider: deps.provider,
        title: deriveTitle(row, deps.maxTitleChars, deps.emptyTitlePlaceholder),
        cwd: row.cwd,
        repository: row.repository,
        branch: row.branch,
        model: row.model,
        messageCount: row.message_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
  };
}
