import type { DatabaseSync } from 'node:sqlite';
import type {
  ContextDocument,
  ContextScope,
  ContextUpdatedBy,
} from '../context-store/context-contract.js';
import type { ContextStore } from '../context-store/context-store-port.js';

interface ContextDocumentRow {
  scope: string;
  scope_id: string;
  content: string;
  updated_at: string;
  updated_by: string;
}

/** SQLite-backed implementation of the ContextStore port. */
export function createContextRepo(db: DatabaseSync): ContextStore {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO context_documents
       (scope, scope_id, content, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare(
    'SELECT * FROM context_documents WHERE scope = ? AND scope_id = ?',
  );
  const deleteOne = db.prepare(
    'DELETE FROM context_documents WHERE scope = ? AND scope_id = ?',
  );

  return {
    get(scope: ContextScope, scopeId: string) {
      const row = selectOne.get(scope, scopeId) as
        | ContextDocumentRow
        | undefined;
      if (!row) {
        return null;
      }
      return {
        scope: row.scope as ContextScope,
        scopeId: row.scope_id,
        content: row.content,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by as ContextUpdatedBy,
      };
    },
    save(doc: ContextDocument) {
      upsert.run(
        doc.scope,
        doc.scopeId,
        doc.content,
        doc.updatedAt,
        doc.updatedBy,
      );
    },
    delete(scope: ContextScope, scopeId: string) {
      deleteOne.run(scope, scopeId);
    },
  };
}
