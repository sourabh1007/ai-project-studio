import type { DatabaseSync } from 'node:sqlite';
import type { MetaOperation, MetaOperationRepo, MetaOperationSummary } from '../meta/meta-operation-contract.js';
import { createMetaUsageRepo } from './meta-usage-repo.js';

const fields = [
  'feature_id', 'automation_id', 'origin_session_id', 'provider_id', 'requested_model',
  'resolved_model', 'session_id', 'provider_session_id', 'session_ids_json', 'transport',
  'state', 'outcome', 'purpose', 'label', 'result_text', 'error_message', 'usage_state',
  'usage_json', 'created_at', 'updated_at', 'started_at', 'finished_at',
] as const;
const metadata = ['operation_id', ...fields.filter((field) => field !== 'result_text')]
  .map((field) => `operation.${field}`).join(', ');

interface Row {
  operation_id: string;
  feature_id: string;
  automation_id: string | null;
  origin_session_id: string | null;
  provider_id: string | null;
  requested_model: string | null;
  resolved_model: string | null;
  session_id: string | null;
  provider_session_id: string | null;
  session_ids_json: string;
  transport: MetaOperation['transport'];
  state: MetaOperation['state'];
  outcome: MetaOperation['outcome'];
  purpose: string | null;
  label: string | null;
  result_text: string | null;
  error_message: string | null;
  usage_state: MetaOperation['usageState'];
  usage_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function mapMetadata(row: Omit<Row, 'result_text'>): Omit<MetaOperation, 'resultText'> {
  return {
    operationId: row.operation_id, featureId: row.feature_id, automationId: row.automation_id,
    originSessionId: row.origin_session_id, providerId: row.provider_id, requestedModel: row.requested_model,
    resolvedModel: row.resolved_model, sessionId: row.session_id, providerSessionId: row.provider_session_id,
    sessionIds: JSON.parse(row.session_ids_json) as string[], transport: row.transport,
    state: row.state, outcome: row.outcome, purpose: row.purpose, label: row.label,
    errorMessage: row.error_message, usageState: row.usage_state,
    usage: row.usage_json === null ? null : JSON.parse(row.usage_json) as MetaOperation['usage'],
    createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

function values(op: MetaOperation): Array<string | null> {
  return [
    op.featureId, op.automationId, op.originSessionId, op.providerId, op.requestedModel,
    op.resolvedModel, op.sessionId, op.providerSessionId, JSON.stringify(op.sessionIds),
    op.transport, op.state, op.outcome, op.purpose, op.label, op.resultText,
    op.errorMessage, op.usageState, op.usage === null ? null : JSON.stringify(op.usage),
    op.createdAt, op.updatedAt, op.startedAt, op.finishedAt,
  ];
}

function pageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid meta operation page limit');
}

export function createMetaOperationRepo(db: DatabaseSync): MetaOperationRepo {
  const usage = createMetaUsageRepo(db);
  const insert = db.prepare(`INSERT INTO meta_operations(operation_id, ${fields.join(',')})
    VALUES (${['operation_id', ...fields].map(() => '?').join(',')})`);
  const update = db.prepare(`UPDATE meta_operations SET ${fields.map((field) => `${field}=?`).join(',')}
    WHERE operation_id = ? AND state IN ('pending','running')`);
  const get = db.prepare('SELECT * FROM meta_operations WHERE operation_id = ?');
  const deleteFeature = db.prepare('DELETE FROM meta_operations WHERE feature_id = ?');
  const deleteAutomation = db.prepare('DELETE FROM meta_operations WHERE automation_id = ?');
  const deleteSession = db.prepare(`DELETE FROM meta_operations WHERE operation_id IN (
    SELECT operation_id FROM meta_operation_sessions WHERE session_id = ?)`);
  const deleteIdentities = db.prepare('DELETE FROM meta_operation_sessions WHERE operation_id = ?');
  const insertIdentity = db.prepare('INSERT INTO meta_operation_sessions (session_id, operation_id) VALUES (?, ?)');
  const replaceIdentities = (operation: MetaOperation): void => {
    deleteIdentities.run(operation.operationId);
    for (const sessionId of new Set([operation.originSessionId, operation.sessionId, ...operation.sessionIds])) {
      if (sessionId !== null) insertIdentity.run(sessionId, operation.operationId);
    }
  };
  const write = <T>(run: () => T): T => {
    if (db.isTransaction) throw new Error('Meta operation persistence requires an independent durable commit');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const updateRow = (operation: MetaOperation): boolean => {
    if (Number(update.run(...values(operation), operation.operationId).changes) !== 1) return false;
    replaceIdentities(operation);
    return true;
  };

  return {
    create(operation) {
      write(() => {
        insert.run(operation.operationId, ...values(operation));
        replaceIdentities(operation);
      });
    },
    get(operationId) {
      const row = get.get(operationId) as unknown as Row | undefined;
      return row ? { ...mapMetadata(row), resultText: row.result_text } : null;
    },
    update(operation) { return write(() => updateRow(operation)); },
    complete(operation, warmUsage) {
      return write(() => {
        if (operation.state !== 'completed' || operation.resultText === null) {
          throw new Error('Meta operation completion requires the full result');
        }
        if (!updateRow(operation)) return false;
        if (warmUsage) usage.save(warmUsage);
        return true;
      });
    },
    listUnfinishedPage(afterOperationId, limit) {
      pageLimit(limit);
      const rows = db.prepare(`SELECT * FROM meta_operations WHERE state IN ('pending','running')
        ${afterOperationId === null ? '' : 'AND operation_id > ?'}
        ORDER BY operation_id LIMIT ?`).all(
        ...(afterOperationId === null ? [limit + 1] : [afterOperationId, limit + 1]),
      ) as unknown as Row[];
      const items = rows.slice(0, limit).map((row) => ({ ...mapMetadata(row), resultText: row.result_text }));
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].operationId : null };
    },
    listPage(filter, afterOperationId, limit) {
      pageLimit(limit);
      const clauses: string[] = [];
      const args: Array<string | number> = [];
      let from = 'meta_operations AS operation';
      let key = 'operation.operation_id';
      if (filter.featureId !== undefined) { clauses.push('operation.feature_id = ?'); args.push(filter.featureId); }
      if (filter.automationId !== undefined) { clauses.push('operation.automation_id = ?'); args.push(filter.automationId); }
      if (filter.sessionId !== undefined) {
        from = `meta_operation_sessions AS identity CROSS JOIN meta_operations AS operation
          ON operation.operation_id = identity.operation_id`;
        key = 'identity.operation_id';
        clauses.push('identity.session_id = ?');
        args.push(filter.sessionId);
      }
      if (afterOperationId !== null) { clauses.push(`${key} > ?`); args.push(afterOperationId); }
      const rows = db.prepare(`SELECT ${metadata}, operation.result_text IS NOT NULL AS has_result FROM ${from}
        ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
        ORDER BY ${key} LIMIT ?`).all(...args, limit + 1) as unknown as Array<Omit<Row, 'result_text'> & { has_result: number }>;
      const items: MetaOperationSummary[] = rows.slice(0, limit).map((row) => ({
        ...mapMetadata(row), hasResult: row.has_result === 1,
      }));
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].operationId : null };
    },
    deleteByFeature(featureId) { deleteFeature.run(featureId); },
    deleteBySession(sessionId) { deleteSession.run(sessionId); },
    deleteByAutomation(automationId) { deleteAutomation.run(automationId); },
  };
}
