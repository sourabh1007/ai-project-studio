import { NotFoundError } from '../kernel/error-types.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionLauncher } from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { SummarizerConfig } from '../summarizer/config.js';
import { extractSummaryText } from '../summarizer/summary-response-extractor.js';
import type { ContextConfig } from './config.js';
import type { ContextDocument } from './context-contract.js';
import type { ContextService } from './context-service.js';
import type { ContextStatus } from './context-status.js';

export interface ContextMergeRunnerDeps {
  sessions: Pick<SessionRepo, 'get'>;
  features: Pick<FeatureService, 'get'>;
  transcripts: Pick<TranscriptStore, 'load'>;
  launcher: Pick<SessionLauncher, 'start'>;
  service: Pick<ContextService, 'get' | 'setContent'>;
  summarizerConfig: SummarizerConfig;
  config: ContextConfig;
  /**
   * Optional sink for lifecycle frames so the UI can animate the otherwise
   * invisible background merge. No-op when omitted (keeps the runner testable
   * and decoupled from the event bus).
   */
  onStatus?: (status: ContextStatus) => void;
}

export interface ContextMerger {
  /**
   * Curates the feature-scope context document from one completed dev session.
   * Returns the updated document, or `null` when the merge produced nothing
   * usable (leaving the prior document untouched).
   */
  merge(input: { sessionId: string }): Promise<ContextDocument | null>;
}

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.split(`{{${key}}}`).join(value),
    template,
  );
}

/**
 * Agent-curated merge of a session's learnings into its feature's shared
 * context. Spawns a silent `meta` session fed the existing document plus the
 * session transcript, then persists the rewritten bullet list. Mirrors the
 * session-summary runner so behaviour stays consistent, but writes to the
 * layered context store (which fires live-push) instead of a summary row.
 */
export function createContextMergeRunner(
  deps: ContextMergeRunnerDeps,
): ContextMerger {
  return {
    async merge({ sessionId }) {
      const session = deps.sessions.get(sessionId);
      if (!session) {
        throw new NotFoundError(`Unknown session: ${sessionId}`);
      }
      const featureId = session.featureId;
      const emit = (phase: ContextStatus['phase']): void =>
        deps.onStatus?.({ scope: 'feature', scopeId: featureId, phase });

      const feature = deps.features.get(featureId);
      const transcript = await deps.transcripts.load(session.id);

      const rawOutput = (transcript?.stdout.join('\n').trim() ?? '').slice(
        0,
        deps.config.maxMergeInputChars,
      );
      const existing =
        deps.service.get('feature', featureId)?.content.trim() ?? '';

      const prompt = render(deps.config.mergePromptTemplate, {
        featureName: feature.name,
        featureDescription: feature.description,
        existingContext:
          existing.length > 0 ? existing : deps.config.emptyContextPlaceholder,
        sessionOutput:
          rawOutput.length > 0 ? rawOutput : deps.config.emptyOutputPlaceholder,
      });

      emit('generating');
      const launched = await deps.launcher.start({
        featureId,
        providerId: deps.summarizerConfig.providerId,
        model: deps.summarizerConfig.model,
        prompt,
        kind: 'meta',
      });
      const ended = await launched.completion;

      const metaTranscript = await deps.transcripts.load(ended.id);
      const curated = extractSummaryText(metaTranscript, {
        ...deps.summarizerConfig,
        maxSummaryChars: deps.config.maxDocChars,
      });
      if (curated.length === 0) {
        emit('idle');
        return null;
      }

      emit('saving');
      const saved = deps.service.setContent({
        scope: 'feature',
        scopeId: featureId,
        content: curated,
        updatedBy: 'merge',
      });
      emit('sharing');
      emit('idle');
      return saved;
    },
  };
}
