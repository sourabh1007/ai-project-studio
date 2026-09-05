import { describe, it, expect } from 'vitest';
import {
  buildSettingsContext,
  buildSettingsPrompt,
  createSettingsAssistant,
  type SettingsAssistantRequest,
} from './settings-assistant.js';
import type { FieldMeta } from './config-schema-describe.js';
import type { MetaRequest } from '../meta/meta-runner.js';

const schema: Record<string, FieldMeta> = {
  meta: {
    kind: 'object',
    fields: {
      model: {
        kind: 'string',
        description: 'The AI model powering metasessions.',
      },
      warmPoolSize: {
        kind: 'number',
        int: true,
        min: 0,
        max: 10,
        default: 2,
        description: 'Number of warm sessions kept ready.',
      },
      priceCategory: {
        kind: 'enum',
        options: ['low', 'medium', 'high'],
        optional: true,
        nullable: true,
      },
      nested: { kind: 'object', fields: {} },
    },
  },
  empty: { kind: 'object', fields: {} },
  scalar: { kind: 'string' },
};

const current = {
  meta: {
    model: 'gpt-5.4',
    warmPoolSize: 3,
    priceCategory: null,
    nested: { a: 1 },
  },
} as Record<string, unknown>;

describe('buildSettingsContext', () => {
  it('describes a single string setting with its current value', () => {
    const out = buildSettingsContext(schema, current, 'meta', 'model');
    expect(out).toContain('Setting: meta.model');
    expect(out).toContain('Type: string');
    expect(out).toContain('Description: The AI model powering metasessions.');
    expect(out).toContain('Current value: gpt-5.4');
  });

  it('describes a numeric setting with bounds and default', () => {
    const out = buildSettingsContext(schema, current, 'meta', 'warmPoolSize');
    expect(out).toContain('Type: number, integer');
    expect(out).toContain('Range: 0 to 10');
    expect(out).toContain('Default: 2');
    expect(out).toContain('Current value: 3');
  });

  it('describes an enum setting with options, optional/nullable flags and null value', () => {
    const out = buildSettingsContext(schema, current, 'meta', 'priceCategory');
    expect(out).toContain('Type: enum, optional, nullable');
    expect(out).toContain('Allowed values: low, medium, high');
    expect(out).toContain('No description provided.');
    expect(out).toContain('Current value: null');
  });

  it('serializes object current values and handles half-open ranges', () => {
    const partial: Record<string, FieldMeta> = {
      meta: {
        kind: 'object',
        fields: { nested: { kind: 'object', fields: {}, min: 1 } },
      },
    };
    const out = buildSettingsContext(partial, current, 'meta', 'nested');
    expect(out).toContain('Range: 1 to no maximum');
    expect(out).toContain('Current value: {"a":1}');
  });

  it('handles a range with only an upper bound', () => {
    const upper: Record<string, FieldMeta> = {
      meta: { kind: 'object', fields: { n: { kind: 'number', max: 5 } } },
    };
    const out = buildSettingsContext(upper, {}, 'meta', 'n');
    expect(out).toContain('Range: no minimum to 5');
  });

  it('treats an object namespace without a fields map as empty', () => {
    const out = buildSettingsContext(
      { meta: { kind: 'object' } },
      {},
      'meta',
    );
    expect(out).toContain(
      '(No schema metadata is available for this namespace.)',
    );
  });

  it('falls back when the setting has no schema metadata', () => {
    const out = buildSettingsContext(schema, current, 'meta', 'ghost');
    expect(out).toContain('(No schema metadata is available for this setting.)');
    expect(out).toContain('Current value: (unset)');
  });

  it('lists all settings when no key is given', () => {
    const out = buildSettingsContext(schema, current, 'meta');
    expect(out).toContain('Settings in this namespace:');
    expect(out).toContain('- model (string): current gpt-5.4 — The AI model');
    expect(out).toContain('- warmPoolSize (number): current 3');
    expect(out).toContain('- priceCategory (enum): current null');
  });

  it('reports when a namespace has no fields', () => {
    const out = buildSettingsContext(schema, {}, 'empty');
    expect(out).toContain(
      '(No schema metadata is available for this namespace.)',
    );
  });

  it('treats a non-object namespace schema as having no fields', () => {
    const out = buildSettingsContext(schema, {}, 'scalar');
    expect(out).toContain(
      '(No schema metadata is available for this namespace.)',
    );
  });

  it('formats empty-string current values distinctly', () => {
    const out = buildSettingsContext(
      { meta: { kind: 'object', fields: { model: { kind: 'string' } } } },
      { meta: { model: '' } },
      'meta',
      'model',
    );
    expect(out).toContain('Current value: (empty string)');
  });
});

describe('buildSettingsPrompt', () => {
  it('embeds the context and the question', () => {
    const req: SettingsAssistantRequest = {
      namespace: 'meta',
      key: 'model',
      question: 'What should I pick?',
    };
    const prompt = buildSettingsPrompt(req, 'CONTEXT-BLOCK');
    expect(prompt).toContain('configuration assistant');
    expect(prompt).toContain('CONTEXT-BLOCK');
    expect(prompt).toContain('User question: What should I pick?');
  });
});

describe('createSettingsAssistant', () => {
  it('runs a tool-free internal turn and trims the answer', async () => {
    let captured: MetaRequest | undefined;
    const assistant = createSettingsAssistant({
      ai: {
        run: async (request) => {
          captured = request;
          return '  Use gpt-5.4.  ';
        },
      },
      timeoutMs: 12_345,
    });
    const answer = await assistant.ask(
      { namespace: 'meta', key: 'model', question: 'Which model?' },
      'CTX',
    );
    expect(answer).toBe('Use gpt-5.4.');
    expect(captured?.featureId).toBe('settings-assistant');
    expect(captured?.noTools).toBe(true);
    expect(captured?.scope).toBe('internal');
    expect(captured?.purpose).toBe('general');
    expect(captured?.timeoutMs).toBe(12_345);
    expect(captured?.label).toBe('Settings assistant · meta.model');
    expect(captured?.prompt).toContain('CTX');
  });

  it('labels namespace-level questions without a key', async () => {
    let captured: MetaRequest | undefined;
    const assistant = createSettingsAssistant({
      ai: {
        run: async (request) => {
          captured = request;
          return 'answer';
        },
      },
    });
    await assistant.ask({ namespace: 'meta', question: 'Explain these.' }, 'CTX');
    expect(captured?.label).toBe('Settings assistant · meta');
    expect(captured?.timeoutMs).toBeUndefined();
  });
});
