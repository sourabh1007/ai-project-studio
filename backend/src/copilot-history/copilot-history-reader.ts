import type { CopilotHistoryConfig } from './config.js';
import type {
  CheckpointSummary,
  CopilotHistoryReader,
  CopilotHistorySource,
  SessionHistory,
} from './copilot-history-contract.js';

export interface CopilotHistoryReaderDeps {
  source: CopilotHistorySource;
  config: CopilotHistoryConfig;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Turns the CLI store's raw session/checkpoint rows into per-session history.
 * Checkpoints are ordered newest-first, capped, and their overviews truncated
 * per config. Sessions with no history still appear (empty checkpoints, null
 * summary) so callers can render every session they asked about.
 */
export function createCopilotHistoryReader(
  deps: CopilotHistoryReaderDeps,
): CopilotHistoryReader {
  const { source, config } = deps;

  return {
    read(sessionIds) {
      if (sessionIds.length === 0 || !source.available()) {
        return sessionIds.map((sessionId) => ({
          sessionId,
          summary: null,
          firstUserMessage: null,
          checkpoints: [],
        }));
      }

      const summaryById = new Map<
        string,
        { summary: string | null; firstUserMessage: string | null }
      >();
      for (const row of source.sessionSummaries(sessionIds)) {
        summaryById.set(row.id, {
          summary: row.summary,
          firstUserMessage: row.first_user_message,
        });
      }

      const checkpointsById = new Map<string, CheckpointSummary[]>();
      for (const row of source.checkpoints(sessionIds)) {
        const list = checkpointsById.get(row.session_id) ?? [];
        list.push({
          number: row.checkpoint_number,
          title: row.title ?? '',
          overview: truncate(row.overview ?? '', config.maxOverviewChars),
          createdAt: row.created_at,
        });
        checkpointsById.set(row.session_id, list);
      }

      return sessionIds.map((sessionId): SessionHistory => {
        const checkpoints = (checkpointsById.get(sessionId) ?? [])
          .sort((a, b) => b.number - a.number)
          .slice(0, config.maxCheckpointsPerSession);
        const summary = summaryById.get(sessionId);
        return {
          sessionId,
          summary: summary?.summary ?? null,
          firstUserMessage: summary?.firstUserMessage ?? null,
          checkpoints,
        };
      });
    },
  };
}
