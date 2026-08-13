import { z } from 'zod';

/**
 * Configuration for the **Monitors & Automations** engine: the background
 * scheduler that ticks monitors, runs checks, and fires actions. Bounds are
 * enforced so an AI-registered monitor can't hammer CI APIs or spawn unbounded
 * concurrent work.
 */
export const AUTOMATION_NAMESPACE = 'automation';

export const automationConfigSchema = z.object({
  /** Default poll interval (ms) when a monitor does not specify one. */
  defaultIntervalMs: z.number().int().positive(),
  /** Hard floor (ms) for any monitor's poll interval (rate-limit guard). */
  minIntervalMs: z.number().int().positive(),
  /** Maximum number of monitors that may run a check concurrently. */
  maxConcurrentChecks: z.number().int().positive(),
  /** Maximum number of `active` automations allowed at once. */
  maxActiveAutomations: z.number().int().positive(),
  /** Hard ceiling (ms) for a single check or action execution. */
  runTimeoutMs: z.number().int().positive(),
});

export type AutomationConfig = z.infer<typeof automationConfigSchema>;

export const automationDefaults: AutomationConfig = {
  // 60s: responsive enough for CI polling without hammering APIs.
  defaultIntervalMs: 60_000,
  // 10s floor so an AI-registered monitor can't busy-poll.
  minIntervalMs: 10_000,
  maxConcurrentChecks: 4,
  maxActiveAutomations: 50,
  // 5 minutes: matches the meta-runner ceiling for AI checks/actions.
  runTimeoutMs: 300_000,
};
