import type { SessionSpec } from '../provider-contract.js';

/**
 * Produces the environment for a Copilot session so its OpenTelemetry usage is
 * written to a per-session JSONL file and tagged with the owning feature and
 * session. This is how usage is attributed back to a Feature/Session.
 */
export function buildCopilotEnv(
  spec: SessionSpec,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.COPILOT_OTEL_ENABLED = 'true';
  env.COPILOT_OTEL_FILE_EXPORTER_PATH = spec.otelFilePath;
  env.OTEL_RESOURCE_ATTRIBUTES = [
    `feature.id=${spec.featureId}`,
    `session.id=${spec.sessionId}`,
    `cw.session.kind=${spec.kind}`,
  ].join(',');
  return env;
}
