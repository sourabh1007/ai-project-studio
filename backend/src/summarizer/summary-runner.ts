import type { Clock } from '../kernel/clock.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionLauncher } from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { SummarizerConfig } from './config.js';
import { buildSummaryPrompt } from './summary-prompt-builder.js';
import { extractSummaryText } from './summary-response-extractor.js';
import type { TranscriptCollector } from './transcript-collector.js';
import type {
  FeatureSummarizer,
  FeatureSummary,
} from './summarizer-contract.js';
import type { SummaryStore } from './summary-store-port.js';

export interface SummaryRunnerDeps {
  collector: TranscriptCollector;
  launcher: SessionLauncher;
  transcripts: TranscriptStore;
  summaries: SummaryStore;
  features: FeatureService;
  clock: Clock;
  config: SummarizerConfig;
}

/**
 * Runs a `meta` AI session that summarizes a feature's development sessions,
 * persists the result, and attaches it to the feature. Meta sessions are
 * excluded from dev-cost rollups by the aggregation module.
 */
export function createSummaryRunner(deps: SummaryRunnerDeps): FeatureSummarizer {
  return {
    async summarize(request) {
      const collected = await deps.collector.collect(request.featureId);
      const prompt = buildSummaryPrompt(collected, deps.config);

      const launched = await deps.launcher.start({
        featureId: request.featureId,
        providerId: deps.config.providerId,
        model: deps.config.model,
        prompt,
        kind: 'meta',
      });
      const ended = await launched.completion;

      const transcript = await deps.transcripts.load(ended.id);
      const extracted = extractSummaryText(transcript, deps.config);
      const content =
        extracted.length > 0 ? extracted : deps.config.emptySummaryPlaceholder;

      const summary: FeatureSummary = {
        featureId: request.featureId,
        content,
        createdAt: deps.clock.isoNow(),
      };
      deps.summaries.save(summary);
      deps.features.attachSummary(request.featureId, content);
      return summary;
    },
  };
}
