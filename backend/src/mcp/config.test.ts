import { describe, it, expect } from 'vitest';
import { mcpConfigSchema, mcpDefaults, MCP_NAMESPACE } from './config.js';

describe('mcp config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(MCP_NAMESPACE).toBe('mcp');
    expect(() => mcpConfigSchema.parse(mcpDefaults)).not.toThrow();
  });

  it('requires a positive integer discovery timeout', () => {
    expect(() =>
      mcpConfigSchema.parse({ enabled: true, discoveryTimeoutMs: 0 }),
    ).toThrow();
    expect(() =>
      mcpConfigSchema.parse({ enabled: true, discoveryTimeoutMs: 1.5 }),
    ).toThrow();
  });

  it('supports configurable native execution without treating an unknown isolation policy as valid', () => {
    expect(mcpConfigSchema.parse({ enabled: true, discoveryTimeoutMs: 1000 }).headlessPolicies)
      .toEqual({ copilot: 'isolated', agency: 'native', claude: 'native' });
    expect(mcpConfigSchema.parse({ ...mcpDefaults, headlessPolicies: { agency: 'isolated' } }).headlessPolicies)
      .toEqual({ agency: 'isolated' });
    expect(mcpConfigSchema.safeParse({ ...mcpDefaults, headlessPolicies: { agency: 'bypass' } }).success).toBe(false);
  });
});
