import type { DatabaseSync } from 'node:sqlite';
import type { SessionKind } from '../provider/provider-contract.js';
import type { StoredUsage, UsageRepo, UsageLookup } from '../usage/usage-repo-port.js';

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
  cost: number | null;
  credits: number | null;
  nano_aiu: number | null;
  charge_provenance: StoredUsage['chargeProvenance'] | null;
  charge_unit: StoredUsage['chargeUnit'];
  usd_estimate: number | null;
  native_session_id: string | null;
  native_message_id: string | null;
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
    nanoAiu: row.nano_aiu === null ? null : Number(row.nano_aiu),
    ...(row.charge_provenance === null ? {} : {
      chargeProvenance: row.charge_provenance,
      chargeUnit: row.charge_unit,
      usdEstimate: row.usd_estimate,
    }),
    ...(row.native_session_id === null ? {} : { nativeSessionId: row.native_session_id }),
    ...(row.native_message_id === null ? {} : { nativeMessageId: row.native_message_id }),
    serviceRequestId: row.service_request_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** SQLite-backed implementation of the UsageRepo port. */
export function createUsageRepo(db: DatabaseSync): UsageRepo & UsageLookup {
  const upsert = db.prepare(
    `INSERT INTO usage_events
      (session_id, feature_id, turn_index, kind, provider, requested_model,
       resolved_model, operation, input_tokens, output_tokens,
       reasoning_output_tokens, cost, credits, nano_aiu, service_request_id,
       started_at, ended_at, charge_provenance, charge_unit, usd_estimate, native_session_id, native_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, turn_index) DO UPDATE SET
       requested_model=excluded.requested_model, resolved_model=excluded.resolved_model,
       input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
       reasoning_output_tokens=excluded.reasoning_output_tokens, cost=excluded.cost,
       credits=excluded.credits, nano_aiu=excluded.nano_aiu,
       charge_provenance=excluded.charge_provenance, charge_unit=excluded.charge_unit,
       usd_estimate=excluded.usd_estimate, service_request_id=excluded.service_request_id,
       ended_at=excluded.ended_at
     WHERE usage_events.provider=excluded.provider
       AND usage_events.feature_id=excluded.feature_id
       AND usage_events.native_session_id IS excluded.native_session_id
       AND usage_events.native_message_id IS excluded.native_message_id`,
  );
  const selectBySession = db.prepare(
    'SELECT * FROM usage_events WHERE session_id = ? ORDER BY turn_index',
  );
  const selectOne = db.prepare('SELECT * FROM usage_events WHERE session_id = ? AND turn_index = ?');
  const deleteBySession = db.prepare(
    'DELETE FROM usage_events WHERE session_id = ?',
  );

  return {
    get(sessionId, turnIndex) {
      const row = selectOne.get(sessionId, turnIndex) as unknown as UsageRow | undefined;
      return row ? mapUsage(row) : null;
    },
    saveAll(events) {
      for (const e of events) {
        const result = upsert.run(
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
          e.chargeProvenance ?? null,
          e.chargeUnit ?? null,
          e.usdEstimate ?? null,
          e.nativeSessionId ?? null,
          e.nativeMessageId ?? null,
        );
        if (Number(result.changes) === 0) throw new Error('Usage attribution is immutable');
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
