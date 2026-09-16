import { z } from 'zod';
import {
  DEFAULT_DECOMPOSE_PROMPT_TEMPLATE,
  DEFAULT_IMPLEMENT_PROMPT_TEMPLATE,
  DEFAULT_PLAN_PROMPT_TEMPLATE,
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  DEFAULT_WORKER_PROMPT_TEMPLATE,
} from './new-task-prompt.js';

/** Configuration schema for the New Task agent. */
export const NEW_TASK_NAMESPACE = 'newTask';

export const newTaskConfigSchema = z.object({
  /** Per-step wall-clock budget for the planning AI turn, in milliseconds. */
  planTimeoutMs: z.number().int().positive(),
  /** Per-step wall-clock budget for the implementation AI turn, in milliseconds. */
  implementTimeoutMs: z.number().int().positive(),
  /**
   * The most worker agents the manager may run in parallel for one
   * implementation. The manager picks the actual count (1..this) from the plan.
   */
  maxWorkers: z.number().int().min(1).max(8),
  /**
   * Planning prompt template. Editable from the New Task agent's settings.
   * Placeholders: {{problem}}, {{context}}.
   */
  planPromptTemplate: z.string().min(1),
  /**
   * Implementation prompt template. Editable from the New Task agent's
   * settings. Placeholders: {{problem}}, {{context}}, {{plan}}.
   */
  implementPromptTemplate: z.string().min(1),
  /**
   * Manager decomposition prompt. Splits the plan into file-disjoint slices.
   * Placeholders: {{problem}}, {{context}}, {{plan}}, {{maxWorkers}}.
   */
  decomposePromptTemplate: z.string().min(1),
  /**
   * Worker prompt. Implements one slice, touching only its assigned files.
   * Placeholders: {{problem}}, {{context}}, {{plan}}, {{title}},
   * {{description}}, {{files}}.
   */
  workerPromptTemplate: z.string().min(1),
  /**
   * Manager review prompt. Integrates the slices and builds only the affected
   * projects. Placeholders: {{problem}}, {{context}}, {{plan}}.
   */
  reviewPromptTemplate: z.string().min(1),
});

export type NewTaskConfig = z.infer<typeof newTaskConfigSchema>;

export const newTaskDefaults: NewTaskConfig = {
  // Planning and implementation are long agentic turns whose real duration
  // varies wildly with repository size. A fixed wall-clock budget produced
  // spurious "timed out" failures on large repos even while the agent was
  // actively working, so the budget is set effectively unbounded (24h). The
  // user-facing "Cancel & reset" control is the intended way to stop a run.
  planTimeoutMs: 86_400_000,
  implementTimeoutMs: 86_400_000,
  maxWorkers: 4,
  planPromptTemplate: DEFAULT_PLAN_PROMPT_TEMPLATE,
  implementPromptTemplate: DEFAULT_IMPLEMENT_PROMPT_TEMPLATE,
  decomposePromptTemplate: DEFAULT_DECOMPOSE_PROMPT_TEMPLATE,
  workerPromptTemplate: DEFAULT_WORKER_PROMPT_TEMPLATE,
  reviewPromptTemplate: DEFAULT_REVIEW_PROMPT_TEMPLATE,
};
