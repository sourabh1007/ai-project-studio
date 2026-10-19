import type { DatabaseSync } from 'node:sqlite';
import type { SkillOrigin, SkillUsageKind, SkillUsageRepo, SkillUsageRow } from '../skill-usage/skill-usage-contract.js';

/** Bounded indexed windows keep analytics reads off the unbounded history. */
export function createSkillUsageRepo(db: DatabaseSync): SkillUsageRepo {
  const insert = db.prepare(`INSERT INTO skill_usage (
    event_id, feature_id, session_id, provider, repo_id, identity, name, source, kind, scope,
    input_tokens, output_tokens, nano_aiu, recorded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (provider, session_id, event_id) DO UPDATE SET
    input_tokens = COALESCE(skill_usage.input_tokens, excluded.input_tokens),
    output_tokens = COALESCE(skill_usage.output_tokens, excluded.output_tokens),
    nano_aiu = COALESCE(skill_usage.nano_aiu, excluded.nano_aiu)`);
  const query = (feature: boolean) => db.prepare(`
    WITH recent AS (
      SELECT * FROM skill_usage WHERE scope = ? ${feature ? 'AND feature_id = ?' : ''}
      ORDER BY recorded_at DESC, event_id DESC LIMIT ?
    ), bounded AS (SELECT * FROM recent ORDER BY recorded_at DESC, event_id DESC LIMIT ?)
    SELECT identity, name, source, kind, provider, repo_id,
      (SELECT name FROM repositories WHERE id = bounded.repo_id) AS repo_name,
      COUNT(*) AS uses, COUNT(DISTINCT session_id) AS sessions,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(nano_aiu) AS nano_aiu,
      COUNT(input_tokens) AS reported_input, COUNT(output_tokens) AS reported_output, COUNT(nano_aiu) AS reported_aic,
      MAX(recorded_at) AS last_used_at, (SELECT COUNT(*) FROM recent) AS window_count
    FROM bounded GROUP BY identity, name, source, kind, provider, repo_id
    ORDER BY uses DESC, last_used_at DESC, name, identity`);
  const all = query(false);
  const byFeature = query(true);
  return {
    record(entry) {
      insert.run(entry.eventId, entry.featureId, entry.sessionId, entry.provider, entry.repoId,
        entry.identity, entry.name, entry.source, entry.kind, entry.scope,
        entry.inputTokens, entry.outputTokens, entry.nanoAiu, entry.recordedAt);
    },
    read(filter, maxEvents) {
      const result = filter.featureId === undefined
        ? all.all(filter.scope, maxEvents + 1, maxEvents)
        : byFeature.all(filter.scope, filter.featureId, maxEvents + 1, maxEvents);
      const rows: SkillUsageRow[] = result.map((row) => ({
        identity: row.identity as string, name: row.name as string,
        source: row.source as SkillOrigin, kind: row.kind as SkillUsageKind,
        provider: row.provider as string, repoId: row.repo_id as string | null, repoName: row.repo_name as string | null,
        uses: row.uses as number, sessions: row.sessions as number,
        inputTokens: row.input_tokens as number | null, outputTokens: row.output_tokens as number | null,
        nanoAiu: row.nano_aiu as number | null, reportedInput: row.reported_input as number,
        reportedOutput: row.reported_output as number, reportedAic: row.reported_aic as number, lastUsedAt: row.last_used_at as string,
      }));
      return { rows, limited: result.length > 0 && Number(result[0].window_count) > maxEvents, maxEvents };
    },
  };
}
