import type { DatabaseSync } from 'node:sqlite';
import type { SessionKind } from '../provider/provider-contract.js';
import type { StoredUsage, UsageRepo } from '../usage/usage-repo-port.js';

interface UsageRow {
  session_id: string;
  feature_id: string;
  turn_index: number;
  kind: string;
  provider: string;
  requested_model: string;
  resolved_model: string;
  operation: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cost: number;
  credits: number;
  nano_aiu: number;
  service_request_id: string | null;
  started_at: string;
  ended_at: string;
}

function mapUsage(row: UsageRow): StoredUsage {
  return {
    sessionId: row.session_id,
    featureId: row.feature_id,
    turnIndex: row.turn_index,
    kind: row.kind as SessionKind,
    provider: row.provider,
    requestedModel: row.requested_model,
    resolvedModel: row.resolved_model,
    operation: row.operation,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    cost: row.cost,
    credits: row.credits,
    nanoAiu: Number(row.nano_aiu),
    serviceRequestId: row.service_request_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** SQLite-backed implementation of the UsageRepo port. */
export function createUsageRepo(db: DatabaseSync): UsageRepo {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO usage_events
      (session_id, feature_id, turn_index, kind, provider, requested_model,
       resolved_model, operation, input_tokens, output_tokens,
       reasoning_output_tokens, cost, credits, nano_aiu, service_request_id,
       started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectBySession = db.prepare(
    'SELECT * FROM usage_events WHERE session_id = ? ORDER BY turn_index',
  );
  const deleteBySession = db.prepare(
    'DELETE FROM usage_events WHERE session_id = ?',
  );

  return {
    saveAll(events) {
      for (const e of events) {
        upsert.run(
          e.sessionId,
          e.featureId,
          e.turnIndex,
          e.kind,
          e.provider,
          e.requestedModel,
          e.resolvedModel,
          e.operation,
          e.inputTokens,
          e.outputTokens,
          e.reasoningOutputTokens,
          e.cost,
          e.credits,
          e.nanoAiu,
          e.serviceRequestId,
          e.startedAt,
          e.endedAt,
        );
      }
    },
    listBySession(sessionId) {
      return (selectBySession.all(sessionId) as unknown as UsageRow[]).map(mapUsage);
    },
    deleteBySession(sessionId) {
      deleteBySession.run(sessionId);
    },
  };
}
