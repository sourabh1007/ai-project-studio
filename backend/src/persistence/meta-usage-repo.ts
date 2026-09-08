import type { DatabaseSync } from 'node:sqlite';
import type {
  MetaUsageRepo,
  PersistedMetaUsage,
} from '../meta/meta-usage-contract.js';

interface MetaUsageRow {
  session_id: string;
  feature_id: string;
  provider_id: string;
  requested_model: string;
  resolved_model: string | null;
  transport: 'warm-acp';
  provider_session_id: string | null;
  purpose: string | null;
  label: string | null;
  input_tokens: number | bigint | null;
  output_tokens: number | bigint | null;
  nano_aiu: number | bigint | null;
  credits: number | null;
  captured_at: string;
}

function toNumber(value: number | bigint | null): number | null {
  return value === null ? null : Number(value);
}

function mapRow(row: MetaUsageRow): PersistedMetaUsage {
  return {
    sessionId: row.session_id,
    featureId: row.feature_id,
    providerId: row.provider_id,
    requestedModel: row.requested_model,
    resolvedModel: row.resolved_model,
    transport: row.transport,
    providerSessionId: row.provider_session_id,
    purpose: row.purpose,
    label: row.label,
    inputTokens: toNumber(row.input_tokens),
    outputTokens: toNumber(row.output_tokens),
    nanoAiu: toNumber(row.nano_aiu),
    credits: row.credits,
    capturedAt: row.captured_at,
  };
}

export function createMetaUsageRepo(db: DatabaseSync): MetaUsageRepo {
  const selectOne = db.prepare(
    'SELECT * FROM meta_usage_records WHERE session_id = ?',
  );
  const save = db.prepare(`INSERT INTO meta_usage_records (
      session_id, feature_id, provider_id, requested_model, resolved_model,
      transport, provider_session_id, purpose, label, input_tokens,
      output_tokens, nano_aiu, credits, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      feature_id = excluded.feature_id,
      provider_id = excluded.provider_id,
      requested_model = excluded.requested_model,
      resolved_model = excluded.resolved_model,
      transport = excluded.transport,
      provider_session_id = excluded.provider_session_id,
      purpose = excluded.purpose,
      label = excluded.label,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      nano_aiu = excluded.nano_aiu,
      credits = excluded.credits,
      captured_at = excluded.captured_at`);
  const deleteByFeature = db.prepare(
    'DELETE FROM meta_usage_records WHERE feature_id = ?',
  );
  const deleteBySession = db.prepare(
    'DELETE FROM meta_usage_records WHERE session_id = ?',
  );

  return {
    get(sessionId) {
      const row = selectOne.get(sessionId) as MetaUsageRow | undefined;
      return row ? mapRow(row) : null;
    },
    save(record) {
      save.run(
        record.sessionId,
        record.featureId,
        record.providerId,
        record.requestedModel,
        record.resolvedModel,
        record.transport,
        record.providerSessionId,
        record.purpose,
        record.label,
        record.inputTokens,
        record.outputTokens,
        record.nanoAiu,
        record.credits,
        record.capturedAt,
      );
    },
    deleteByFeature(featureId) {
      deleteByFeature.run(featureId);
    },
    deleteBySession(sessionId) {
      deleteBySession.run(sessionId);
    },
  };
}
