import { z } from 'zod';

/** Configuration namespace for the planner-summary module. */
export const PLANNER_SUMMARY_NAMESPACE = 'plannerSummary';

export const plannerSummaryConfigSchema = z.object({
  /**
   * Synthetic feature id that summary metasessions are attributed to. It is a
   * well-known constant rather than a real feature row (mirroring the
   * `self-recovery`/`self-heal` internal metasessions), so summary usage folds
   * into cost accounting without creating a visible "Planner summaries" feature
   * in the workspace tree.
   */
  hostFeatureId: z.string().min(1),
  /** Overall prompt. Placeholders: {{scope}}, {{range}}, {{guidance}}, {{tasks}}. */
  promptTemplate: z.string().min(1),
  /** Per-task line. Placeholders: {{mark}}, {{date}}, {{priority}}, {{title}}. */
  taskTemplate: z.string().min(1),
  /** Marks for a done and an open task in the rendered list. */
  doneMark: z.string(),
  openMark: z.string(),
  /** Separator inserted between rendered task lines. */
  taskSeparator: z.string(),
  /** Text used when no tasks fall in the requested scope. */
  noTasksPlaceholder: z.string().min(1),
  /** Guidance used when the caller supplies no prompt of their own. */
  defaultGuidance: z.string().min(1),
  /** Text returned when the meta session yields no extractable summary. */
  emptySummaryPlaceholder: z.string().min(1),
  /** Hard cap on characters of the final summary text. */
  maxSummaryChars: z.number().int().positive(),
});

export type PlannerSummaryConfig = z.infer<typeof plannerSummaryConfigSchema>;

export const plannerSummaryDefaults: PlannerSummaryConfig = {
  hostFeatureId: 'planner-summary',
  promptTemplate: [
    'You are reviewing a developer’s personal planner.',
    'Summarize the {{scope}} of {{range}}, limited strictly to the tasks listed below.',
    '',
    'Guidance: {{guidance}}',
    '',
    'Write a concise summary: what was accomplished, what is still open, and any',
    'notable themes. Do not invent tasks that are not listed, and do not discuss',
    'anything beyond these tasks. Format your answer as GitHub-flavored Markdown',
    '(use a short overview paragraph, then bullet points for highlights and open',
    'items). Answer directly from the list below without using any tools.',
    '',
    'Tasks:',
    '{{tasks}}',
  ].join('\n'),
  taskTemplate: '{{mark}} [{{date}} · {{priority}}] {{title}}',
  doneMark: '[x]',
  openMark: '[ ]',
  taskSeparator: '\n',
  noTasksPlaceholder: '(no tasks were planned in this period)',
  defaultGuidance: 'Give a balanced overview of progress and open work.',
  emptySummaryPlaceholder: '(the summary session produced no output)',
  maxSummaryChars: 4000,
};
