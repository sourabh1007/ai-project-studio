import type { SessionLauncher } from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { MetaConfig } from './config.js';
import { extractResponseText } from './meta-response-extractor.js';

export interface MetaRunnerDeps {
  launcher: SessionLauncher;
  transcripts: TranscriptStore;
  config: MetaConfig;
}

/** A single headless AI request: a prompt run against a feature's context. */
export interface MetaRequest {
  featureId: string;
  prompt: string;
}

/**
 * Reusable "AI" primitive: launches a headless `meta` CLI session for a prompt,
 * awaits completion, and returns the extracted assistant response text. Factored
 * out so every AI feature (summaries, task plans, …) shares one config-driven
 * flow instead of duplicating the launcher/extractor plumbing. Meta sessions are
 * excluded from dev-cost rollups by the aggregation module.
 */
export interface MetaRunner {
  run(request: MetaRequest): Promise<string>;
}

export function createMetaRunner(deps: MetaRunnerDeps): MetaRunner {
  return {
    async run(request) {
      const launched = await deps.launcher.start({
        featureId: request.featureId,
        providerId: deps.config.providerId,
        model: deps.config.model,
        prompt: request.prompt,
        kind: 'meta',
      });
      const ended = await launched.completion;
      const transcript = await deps.transcripts.load(ended.id);
      return extractResponseText(transcript, deps.config.responseTextKeys);
    },
  };
}
