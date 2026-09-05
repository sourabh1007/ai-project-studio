import { describe, it, expect } from 'vitest';
import {
  parseAvailableModels,
  parseUsageMultiplier,
} from './model-catalog-parser.js';

const NEW_SESSION_RESULT = {
  sessionId: 'abc',
  models: {
    availableModels: [
      { modelId: 'auto', name: 'Auto', description: 'Let Copilot pick' },
      {
        modelId: 'gpt-5.4',
        name: 'GPT-5.4',
        description: 'GPT-5.4',
        _meta: {
          copilotUsage: '1x',
          copilotEnablement: 'enabled',
          copilotPriceCategory: 'medium',
        },
      },
      {
        modelId: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Claude Opus 5',
        _meta: {
          copilotUsage: '15x',
          copilotEnablement: 'disabled',
          copilotPriceCategory: 'high',
        },
      },
    ],
  },
};

describe('parseUsageMultiplier', () => {
  it('parses integer and decimal multipliers', () => {
    expect(parseUsageMultiplier('15x')).toBe(15);
    expect(parseUsageMultiplier('0.33x')).toBe(0.33);
    expect(parseUsageMultiplier('0x')).toBe(0);
  });

  it('returns null for missing or malformed labels', () => {
    expect(parseUsageMultiplier(null)).toBeNull();
    expect(parseUsageMultiplier('free')).toBeNull();
    expect(parseUsageMultiplier('15')).toBeNull();
  });
});

describe('parseAvailableModels', () => {
  it('maps each advertised model with its pricing hints', () => {
    const models = parseAvailableModels(NEW_SESSION_RESULT);
    expect(models).toHaveLength(3);

    expect(models[0]).toEqual({
      id: 'auto',
      name: 'Auto',
      description: 'Let Copilot pick',
      usageLabel: null,
      usageMultiplier: null,
      priceCategory: null,
      enabled: true,
    });

    expect(models[1]).toMatchObject({
      id: 'gpt-5.4',
      usageLabel: '1x',
      usageMultiplier: 1,
      priceCategory: 'medium',
      enabled: true,
    });

    expect(models[2]).toMatchObject({
      id: 'claude-opus-5',
      usageMultiplier: 15,
      priceCategory: 'high',
      enabled: false,
    });
  });

  it('falls back to the id for a missing name and empty description', () => {
    const [model] = parseAvailableModels({
      models: { availableModels: [{ modelId: 'x' }] },
    });
    expect(model).toEqual({
      id: 'x',
      name: 'x',
      description: '',
      usageLabel: null,
      usageMultiplier: null,
      priceCategory: null,
      enabled: true,
    });
  });

  it('drops entries without a usable modelId', () => {
    const models = parseAvailableModels({
      models: {
        availableModels: [
          { modelId: '' },
          { name: 'no id' },
          'not-an-object',
          null,
          { modelId: 'ok' },
        ],
      },
    });
    expect(models.map((m) => m.id)).toEqual(['ok']);
  });

  it('returns an empty array for a missing or malformed catalog', () => {
    expect(parseAvailableModels(null)).toEqual([]);
    expect(parseAvailableModels({})).toEqual([]);
    expect(parseAvailableModels({ models: null })).toEqual([]);
    expect(parseAvailableModels({ models: { availableModels: 'nope' } })).toEqual(
      [],
    );
  });
});
