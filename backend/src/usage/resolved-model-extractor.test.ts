import { describe, it, expect } from 'vitest';
import { extractResolvedModel } from './resolved-model-extractor.js';
import { usageDefaults } from './config.js';

const keys = usageDefaults.attributeKeys;

describe('resolved-model-extractor', () => {
  it('prefers the response model', () => {
    expect(
      extractResolvedModel(
        { 'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'gpt-5.4-mini' },
        keys,
      ),
    ).toBe('gpt-5.4-mini');
  });

  it('falls back to the request model when response model is absent', () => {
    expect(
      extractResolvedModel({ 'gen_ai.request.model': 'gpt-5.4' }, keys),
    ).toBe('gpt-5.4');
  });

  it('returns unknown when neither is present', () => {
    expect(extractResolvedModel({}, keys)).toBe('unknown');
  });
});
