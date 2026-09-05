import { describe, it, expect } from 'vitest';
import { createSettingsAssistantRoutes } from './settings-assistant-controller.js';
import type { SettingsAssistant } from '../config/settings-assistant.js';
import type { FieldMeta } from '../config/config-schema-describe.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

const schema: Record<string, FieldMeta> = {
  meta: {
    kind: 'object',
    fields: { model: { kind: 'string', description: 'The model.' } },
  },
};

describe('settings-assistant-controller', () => {
  it('grounds the assistant in the setting context and returns the answer', async () => {
    const seen: { context?: string; namespace?: string; key?: string } = {};
    const assistant: SettingsAssistant = {
      ask: async (request, context) => {
        seen.context = context;
        seen.namespace = request.namespace;
        seen.key = request.key;
        return 'Pick gpt-5.4.';
      },
    };
    const handler = pick(
      createSettingsAssistantRoutes({
        assistant,
        schema: () => schema,
        current: { meta: { model: 'gpt-5.4' } },
      }),
      'post',
      '/config/assistant',
    );
    const req: HttpRequest = {
      params: {},
      query: {},
      body: { namespace: 'meta', key: 'model', question: 'Which model?' },
    };
    const res = await handler(req);
    expect(res).toEqual({ status: 200, body: { answer: 'Pick gpt-5.4.' } });
    expect(seen.namespace).toBe('meta');
    expect(seen.key).toBe('model');
    expect(seen.context).toContain('Setting: meta.model');
    expect(seen.context).toContain('Current value: gpt-5.4');
  });

  it('rejects a request without a question', async () => {
    const assistant: SettingsAssistant = {
      ask: async () => 'unused',
    };
    const handler = pick(
      createSettingsAssistantRoutes({
        assistant,
        schema: () => schema,
        current: {},
      }),
      'post',
      '/config/assistant',
    );
    const req: HttpRequest = {
      params: {},
      query: {},
      body: { namespace: 'meta' },
    };
    await expect(handler(req)).rejects.toThrow();
  });
});
