import type { SessionSpec } from '../provider-contract.js';
import { buildCopilotEnv } from '../copilot-adapter/copilot-env-mapper.js';

/**
 * Produces the environment for an Agency session. Agency forwards to the same
 * underlying Copilot CLI, so per-session OpenTelemetry usage is captured with
 * the identical COPILOT_OTEL_* + resource-attribute mapping.
 */
export function buildAgencyEnv(
  spec: SessionSpec,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  return buildCopilotEnv(spec, baseEnv);
}
