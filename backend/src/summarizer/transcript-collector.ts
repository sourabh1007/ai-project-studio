import type { FeatureService } from '../feature/feature-service.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { SummarizerConfig } from './config.js';
import type {
  FeatureTranscripts,
  SessionTranscript,
} from './summarizer-contract.js';

export interface TranscriptCollectorDeps {
  features: FeatureService;
  sessions: SessionRepo;
  transcripts: TranscriptStore;
  config: SummarizerConfig;
}

export interface TranscriptCollector {
  collect(featureId: string): Promise<FeatureTranscripts>;
}

/**
 * Gathers a feature together with the transcripts of its eligible sessions
 * (those whose kind is listed in `config.sourceKinds`). Missing transcripts are
 * represented as null rather than omitted, so the caller sees every session.
 */
export function createTranscriptCollector(
  deps: TranscriptCollectorDeps,
): TranscriptCollector {
  const eligibleKinds = new Set(deps.config.sourceKinds);

  return {
    async collect(featureId) {
      const feature = deps.features.get(featureId);
      const eligible = deps.sessions
        .listByFeature(featureId)
        .filter((session) => eligibleKinds.has(session.kind));

      const sessions: SessionTranscript[] = [];
      for (const session of eligible) {
        const transcript = await deps.transcripts.load(session.id);
        sessions.push({ session, transcript });
      }

      return { feature, sessions };
    },
  };
}
