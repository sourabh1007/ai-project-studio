import { z } from 'zod';

/**
 * Configuration for the task-plan skill's feature-task module. Owns the
 * AI plan-generation prompt template and parse keys so nothing is hardcoded.
 */
export const FEATURE_TASKS_NAMESPACE = 'featureTasks';

export const featureTasksConfigSchema = z.object({
  /** Hard cap on the number of tasks kept from a generated plan. */
  maxTasks: z.number().int().positive(),
  /** Maximum length of a task title (longer titles are clamped). */
  maxTitleLength: z.number().int().positive(),
  /**
   * Plan-generation prompt template. Placeholders: {{featureName}},
   * {{featureDescription}}, {{maxTasks}}.
   */
  promptTemplate: z.string().min(1),
  /** Text substituted for an empty feature description. */
  emptyDescriptionPlaceholder: z.string().min(1),
  /** Candidate JSON keys to read a task's title from a plan item object. */
  titleKeys: z.array(z.string().min(1)).min(1),
  /** Candidate JSON keys to read a task's detail from a plan item object. */
  detailKeys: z.array(z.string().min(1)).min(1),
});

export type FeatureTasksConfig = z.infer<typeof featureTasksConfigSchema>;

export const featureTasksDefaults: FeatureTasksConfig = {
  maxTasks: 12,
  maxTitleLength: 200,
  promptTemplate: [
    'You are planning the implementation of a software feature.',
    'Feature: {{featureName}}',
    'Description: {{featureDescription}}',
    '',
    'Break the work into at most {{maxTasks}} concrete, ordered sub-tasks.',
    'Respond with ONLY a strict JSON array — no prose, no code fences — where',
    'each element is an object with a "title" (short imperative task) and an',
    'optional "detail" (one sentence of extra context). Example:',
    '[{"title":"Add the login form","detail":"Email + password fields"}]',
  ].join('\n'),
  emptyDescriptionPlaceholder: '(no description provided)',
  titleKeys: ['title', 'name', 'task', 'summary'],
  detailKeys: ['detail', 'description', 'notes', 'details'],
};
