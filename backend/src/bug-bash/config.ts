import { z } from 'zod';
import {
  DEFAULT_GENERATE_PROMPT_TEMPLATE,
  DEFAULT_REPORT_PROMPT_TEMPLATE,
  DEFAULT_TESTER_PROMPT_TEMPLATE,
} from './bug-bash-prompt.js';

/** Configuration namespace for the Bug Bash agent. */
export const BUG_BASH_NAMESPACE = 'bugBash';

export const bugBashConfigSchema = z.object({
  /** Per-step wall-clock budget for the scenario-generation turn, in ms. */
  generateTimeoutMs: z.number().int().positive(),
  /** Per-step wall-clock budget for each tester/report turn, in ms. */
  runTimeoutMs: z.number().int().positive(),
  /**
   * The most tester sub-agents the lead may run in parallel for one run. The
   * accepted scenarios are split across up to this many testers.
   */
  maxTesters: z.number().int().min(1).max(8),
  /**
   * Scenario-generation prompt. Placeholders: {{featureInfo}}, {{setupInfo}}.
   */
  generatePromptTemplate: z.string().min(1),
  /**
   * Tester prompt: runs one group of scenarios. Placeholders: {{featureInfo}},
   * {{setupInfo}}, {{scenarios}}.
   */
  testerPromptTemplate: z.string().min(1),
  /**
   * Lead report prompt: compiles the findings. Placeholders: {{featureInfo}},
   * {{results}}.
   */
  reportPromptTemplate: z.string().min(1),
});

export type BugBashConfig = z.infer<typeof bugBashConfigSchema>;

export const bugBashDefaults: BugBashConfig = {
  // Generation and scenario execution are long agentic turns whose real
  // duration varies with repository size. A fixed budget produced spurious
  // "timed out" failures on large repos even while the agent was actively
  // working, so the budget is effectively unbounded (24h). The user-facing
  // "Cancel & reset" control is the intended way to stop a run.
  generateTimeoutMs: 86_400_000,
  runTimeoutMs: 86_400_000,
  maxTesters: 4,
  generatePromptTemplate: DEFAULT_GENERATE_PROMPT_TEMPLATE,
  testerPromptTemplate: DEFAULT_TESTER_PROMPT_TEMPLATE,
  reportPromptTemplate: DEFAULT_REPORT_PROMPT_TEMPLATE,
};
