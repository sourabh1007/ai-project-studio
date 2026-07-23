import type { CopilotHistoryReader } from '../copilot-history/copilot-history-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { SessionSummaryStore } from '../session-summary/session-summary-store-port.js';
import type {
  FeatureWorkSummaryService,
  SessionWorkSummary,
} from './feature-work-summary-contract.js';

export interface FeatureWorkSummaryDeps {
  sessions: SessionRepo;
  reader: CopilotHistoryReader;
  summaries: SessionSummaryStore;
}

/**
 * Builds a feature's work summary purely from data the CLI already recorded:
 * the app's dev sessions joined to the CLI's per-session summaries and
 * checkpoints. An on-demand AI summary (if the user generated one) takes
 * precedence over the CLI's own summary. No AIC is spent building this view.
 */
export function createFeatureWorkSummaryService(
  deps: FeatureWorkSummaryDeps,
): FeatureWorkSummaryService {
  return {
    getByFeature(featureId) {
      const sessions = deps.sessions
        .listByFeature(featureId)
        .filter((session) => session.kind === 'dev');

      const histories = deps.reader.read(sessions.map((session) => session.id));
      const historyBySession = new Map(
        histories.map((history) => [history.sessionId, history]),
      );

      const items: SessionWorkSummary[] = sessions
        .map((session) => {
          const history = historyBySession.get(session.id);
          const generated = deps.summaries.load(session.id);
          return {
            sessionId: session.id,
            prompt: session.prompt,
            status: session.status,
            createdAt: session.createdAt,
            summary: generated?.content ?? history?.summary ?? null,
            checkpoints: history?.checkpoints ?? [],
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return { featureId, sessions: items };
    },
  };
}
