import { z } from 'zod';
import type { ConfigObject } from '../config/config-contract.js';
import type { FieldMeta } from '../config/config-schema-describe.js';
import {
  buildSettingsContext,
  type SettingsAssistant,
} from '../config/settings-assistant.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

export interface SettingsAssistantControllerDeps {
  assistant: SettingsAssistant;
  /**
   * Lazily yields per-namespace schema metadata (descriptions, bounds, enum
   * options) so answers stay grounded in the real settings shape.
   */
  schema: () => Record<string, FieldMeta>;
  /** The effective, merged configuration whose current values are explained. */
  current: ConfigObject;
}

const askSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1).optional(),
  question: z.string().min(1),
});

/**
 * Route backing the Settings page's "Ask AI" helper: given a namespace, an
 * optional setting key, and a free-text question, it grounds the AI in the
 * setting's real schema metadata and current value, then returns a concise
 * explanation and value recommendation.
 */
export function createSettingsAssistantRoutes(
  deps: SettingsAssistantControllerDeps,
): Route[] {
  return [
    {
      method: 'post',
      path: '/config/assistant',
      handler: async (req) => {
        const input = parseInput(askSchema, req.body);
        const context = buildSettingsContext(
          deps.schema(),
          deps.current,
          input.namespace,
          input.key,
        );
        const answer = await deps.assistant.ask(
          {
            namespace: input.namespace,
            key: input.key,
            question: input.question,
          },
          context,
        );
        return { status: 200, body: { answer } };
      },
    },
  ];
}
