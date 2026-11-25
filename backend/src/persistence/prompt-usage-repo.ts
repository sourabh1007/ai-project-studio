import type { DatabaseSync } from 'node:sqlite';
import type { PromptUsageEvent, PromptUsageRepo } from '../meta/prompt-usage-contract.js';

export function createPromptUsageRepo(db: DatabaseSync): PromptUsageRepo {
  const record = db.prepare(`INSERT OR IGNORE INTO prompt_context_events
    (event_id, prompt_refs_json, session_id, provider_id, kind, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`);
  return {
    recordContext(event) {
      if (event.promptRefs.length === 0) return;
      record.run(event.eventId, JSON.stringify([...new Set(event.promptRefs)]),
        event.sessionId, event.providerId, event.kind, event.recordedAt);
    },
    read(filter, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid prompt usage limit');
      const clauses = ['recorded_at >= ?', 'recorded_at < ?'];
      const args: Array<string | number> = [filter.from, filter.to];
      if (filter.promptRef !== undefined) {
        clauses.push('EXISTS (SELECT 1 FROM json_each(prompt_refs_json) WHERE value = ?)');
        args.push(filter.promptRef);
      }
      if (filter.excludeProviderId !== undefined) {
        clauses.push('(provider_id IS NULL OR provider_id <> ?)');
        args.push(filter.excludeProviderId);
      }
      const rows = db.prepare(`SELECT * FROM (
        SELECT 'request:' || operation_id AS event_id, prompt_refs_json, session_id, provider_id,
          'request' AS kind, created_at AS recorded_at, state,
          CASE WHEN transport = 'warm-acp' THEN request_usage_json ELSE usage_json END AS usage_json
          FROM meta_operations WHERE prompt_refs_json IS NOT NULL AND json_array_length(prompt_refs_json) > 0
        UNION ALL
        SELECT 'context:' || event_id, prompt_refs_json, session_id, provider_id,
          kind, recorded_at, 'observed', NULL FROM prompt_context_events
      ) WHERE ${clauses.join(' AND ')} ORDER BY recorded_at DESC, event_id DESC LIMIT ?`)
        .all(...args, limit + 1) as unknown as Array<{
          event_id: string; prompt_refs_json: string; session_id: string | null;
          provider_id: string | null; kind: PromptUsageEvent['kind']; recorded_at: string;
          state: string; usage_json: string | null;
        }>;
      return {
        events: rows.slice(0, limit).map((row) => ({
          eventId: row.event_id, promptRefs: JSON.parse(row.prompt_refs_json) as string[],
          sessionId: row.session_id, providerId: row.provider_id, kind: row.kind,
          recordedAt: row.recorded_at, state: row.state,
          usage: row.usage_json === null ? null : JSON.parse(row.usage_json) as PromptUsageEvent['usage'],
        })),
        limited: rows.length > limit, maxEvents: limit,
      };
    },
  };
}
