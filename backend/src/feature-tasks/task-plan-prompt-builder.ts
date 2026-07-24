import type { Feature } from '../feature/feature-contract.js';
import type { FeatureTasksConfig } from './config.js';

/**
 * Builds the AI plan-generation prompt for a feature from the config-driven
 * template. Substitutes the feature name/description and the task cap; an empty
 * description falls back to the configured placeholder.
 */
export function buildTaskPlanPrompt(
  feature: Feature,
  config: FeatureTasksConfig,
): string {
  const description =
    feature.description.trim().length > 0
      ? feature.description
      : config.emptyDescriptionPlaceholder;
  return config.promptTemplate
    .replaceAll('{{featureName}}', feature.name)
    .replaceAll('{{featureDescription}}', description)
    .replaceAll('{{maxTasks}}', String(config.maxTasks));
}
