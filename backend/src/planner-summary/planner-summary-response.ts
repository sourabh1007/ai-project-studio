import type { PlannerSummaryConfig } from './config.js';

/**
 * Normalizes the assistant text returned by the shared MetaRunner (which has
 * already pulled the response out of the provider's JSON output): trims it and
 * clamps it to the configured maximum length, adding an ellipsis when cut.
 */
export function finalizeSummary(
  text: string,
  config: PlannerSummaryConfig,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= config.maxSummaryChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, config.maxSummaryChars).trimEnd()}…`;
}
