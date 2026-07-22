import type { SummarizerConfig } from './config.js';
import type {
  FeatureTranscripts,
  SessionTranscript,
} from './summarizer-contract.js';

function applyTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.split(`{{${key}}}`).join(value);
  }
  return output;
}

function renderOutput(
  entry: SessionTranscript,
  config: SummarizerConfig,
): string {
  const text = entry.transcript?.stdout.join('\n').trim() ?? '';
  if (text.length === 0) {
    return config.emptyOutputPlaceholder;
  }
  if (text.length > config.maxOutputCharsPerSession) {
    return text.slice(0, config.maxOutputCharsPerSession);
  }
  return text;
}

function renderSession(
  entry: SessionTranscript,
  index: number,
  config: SummarizerConfig,
): string {
  const { session } = entry;
  return applyTemplate(config.sessionTemplate, {
    index: String(index),
    provider: session.provider,
    model: session.resolvedModel ?? session.requestedModel,
    prompt: session.prompt,
    output: renderOutput(entry, config),
  });
}

/**
 * Builds the meta-session prompt from a feature's collected transcripts using
 * the configured templates. Everything is config-driven; no text is hardcoded.
 */
export function buildSummaryPrompt(
  collected: FeatureTranscripts,
  config: SummarizerConfig,
): string {
  const blocks = collected.sessions.map((entry, i) =>
    renderSession(entry, i + 1, config),
  );
  const sessions =
    blocks.length === 0
      ? config.noSessionsPlaceholder
      : blocks.join(config.sessionSeparator);

  return applyTemplate(config.promptTemplate, {
    featureName: collected.feature.name,
    featureDescription: collected.feature.description,
    sessions,
  });
}
