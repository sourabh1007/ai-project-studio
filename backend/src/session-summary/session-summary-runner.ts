import { NotFoundError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionLauncher } from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { SummarizerConfig } from '../summarizer/config.js';
import { buildSummaryPrompt } from '../summarizer/summary-prompt-builder.js';
import { extractSummaryText } from '../summarizer/summary-response-extractor.js';
import type { FeatureTranscripts } from '../summarizer/summarizer-contract.js';
import type {
  SessionSummarizer,
  SessionSummary,
} from './session-summary-contract.js';
import type { SessionSummaryStore } from './session-summary-store-port.js';

export interface SessionSummaryRunnerDeps {
  sessions: SessionRepo;
  features: FeatureService;
  transcripts: TranscriptStore;
  launcher: SessionLauncher;
  store: SessionSummaryStore;
  clock: Clock;
  config: SummarizerConfig;
}

/**
 * Generates a summary of one session by spawning a silent `meta` session that
 * is fed only that session's transcript. The result is persisted against the
 * target (dev) session id so it survives reloads and enriches the work summary.
 * Reuses the summarizer's prompt builder and response extractor so behaviour
 * stays consistent with the feature-level summary.
 */
export function createSessionSummaryRunner(
  deps: SessionSummaryRunnerDeps,
): SessionSummarizer {
  return {
    async summarize({ sessionId }) {
      const session = deps.sessions.get(sessionId);
      if (!session) {
        throw new NotFoundError(`Unknown session: ${sessionId}`);
      }
      const feature = deps.features.get(session.featureId);
      const transcript = await deps.transcripts.load(session.id);
      const collected: FeatureTranscripts = {
        feature,
        sessions: [{ session, transcript }],
      };
      const prompt = buildSummaryPrompt(collected, deps.config);

      const launched = await deps.launcher.start({
        featureId: session.featureId,
        providerId: deps.config.providerId,
        model: deps.config.model,
        prompt,
        kind: 'meta',
      });
      const ended = await launched.completion;

      const metaTranscript = await deps.transcripts.load(ended.id);
      const extracted = extractSummaryText(metaTranscript, deps.config);
      const content =
        extracted.length > 0 ? extracted : deps.config.emptySummaryPlaceholder;

      const summary: SessionSummary = {
        sessionId,
        content,
        createdAt: deps.clock.isoNow(),
      };
      deps.store.save(summary);
      return summary;
    },
    get(sessionId) {
      return deps.store.load(sessionId);
    },
  };
}
